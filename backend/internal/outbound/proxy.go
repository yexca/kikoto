package outbound

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/proxy"
)

func (p *Policy) dialDestination(ctx context.Context, network string, address string) (net.Conn, error) {
	// net/http detaches the dialing context from the request's cancellation
	// to allow connection reuse. Pending DNS/proxy handshakes must still stop
	// when the initiating request leaves, rather than using their full budget.
	if destination, ok := ctx.Value(requestDestinationKey{}).(requestDestination); ok {
		if err := destination.context.Err(); err != nil {
			return nil, err
		}
		connectionContext, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(destination.context, cancel)
		defer func() { stop(); cancel() }()
		ctx = connectionContext
	}
	if p.proxy == nil {
		return p.dial(ctx, network, address)
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, violation("outbound connection address is invalid")
	}
	rule, err := p.requestDestinationRule(ctx, host, port)
	if err != nil {
		return nil, err
	}
	dialCtx, cancel := context.WithTimeout(ctx, p.connectTimeout)
	defer cancel()
	addresses, err := p.validatedAddresses(dialCtx, host, rule)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, resolved := range addresses {
		if network == "tcp4" && !resolved.Is4() || network == "tcp6" && !resolved.Is6() {
			continue
		}
		target := net.JoinHostPort(resolved.String(), port)
		var connection net.Conn
		switch p.proxy.Scheme {
		case "socks5", "socks5h":
			connection, err = p.dialSOCKS(dialCtx, network, target)
		default:
			connection, err = p.dialHTTPTunnel(dialCtx, network, target)
		}
		if err == nil {
			return connection, nil
		}
		lastErr = err
		if dialCtx.Err() != nil {
			return nil, dialCtx.Err()
		}
	}
	if lastErr == nil {
		lastErr = errors.New("outbound hostname has no compatible address")
	}
	return nil, lastErr
}

// The SOCKS dialer is allowed to connect only to the configured proxy. The
// destination passed to its handshake is already numeric, even for SOCKS5h.
func (p *Policy) dialSOCKS(ctx context.Context, network string, target string) (net.Conn, error) {
	var auth *proxy.Auth
	if p.proxy.User != nil {
		auth = &proxy.Auth{User: p.proxy.User.Username()}
		auth.Password, _ = p.proxy.User.Password()
	}
	dialer, err := proxy.SOCKS5("tcp", p.proxyEndpoint, auth, proxyDialer{policy: p})
	if err != nil {
		return nil, errors.New("outbound SOCKS proxy configuration is invalid")
	}
	return dialer.(proxy.ContextDialer).DialContext(ctx, network, target)
}

type proxyDialer struct {
	policy *Policy
}

func (d proxyDialer) Dial(network string, address string) (net.Conn, error) {
	return d.policy.dial(context.Background(), network, address)
}

func (d proxyDialer) DialContext(ctx context.Context, network string, address string) (net.Conn, error) {
	return d.policy.dial(ctx, network, address)
}

func (p *Policy) dialHTTPTunnel(ctx context.Context, network string, target string) (_ net.Conn, err error) {
	connection, err := p.dial(ctx, network, p.proxyEndpoint)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = connection.Close()
		}
	}()
	rawConnection := connection
	stop := context.AfterFunc(ctx, func() { _ = rawConnection.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		if err := connection.SetDeadline(deadline); err != nil {
			return nil, err
		}
	}
	if p.proxy.Scheme == "https" {
		secured := tls.Client(connection, &tls.Config{ServerName: p.proxy.Hostname(), MinVersion: tls.VersionTLS12})
		if err := secured.HandshakeContext(ctx); err != nil {
			return nil, errors.New("outbound proxy TLS handshake failed")
		}
		connection = secured
	}
	connect := &http.Request{
		Method: http.MethodConnect,
		URL:    &url.URL{Opaque: target},
		Host:   target,
		Header: make(http.Header),
	}
	if p.proxy.User != nil {
		password, _ := p.proxy.User.Password()
		credentials := base64.StdEncoding.EncodeToString([]byte(p.proxy.User.Username() + ":" + password))
		connect.Header.Set("Proxy-Authorization", "Basic "+credentials)
	}
	if err := connect.Write(connection); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(io.LimitReader(connection, maxResponseHeaderBytes))
	response, err := http.ReadResponse(reader, connect)
	if err != nil {
		return nil, errors.New("outbound proxy returned an invalid CONNECT response")
	}
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("outbound proxy refused CONNECT")
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if err := connection.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	return &bufferedProxyConn{Conn: connection, reader: reader}, nil
}

type bufferedProxyConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedProxyConn) Read(buffer []byte) (int, error) {
	if buffered := c.reader.Buffered(); buffered > 0 {
		if len(buffer) > buffered {
			buffer = buffer[:buffered]
		}
		return c.reader.Read(buffer)
	}
	return c.Conn.Read(buffer)
}
