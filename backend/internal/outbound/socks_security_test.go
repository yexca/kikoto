package outbound

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestSOCKSProxyReceivesNumericValidatedDestination(t *testing.T) {
	for _, scheme := range []string{"socks5", "socks5h"} {
		t.Run(scheme, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = listener.Close() }()
			result := make(chan error, 1)
			go func() {
				connection, err := listener.Accept()
				if err != nil {
					result <- err
					return
				}
				defer func() { _ = connection.Close() }()
				_ = connection.SetDeadline(time.Now().Add(3 * time.Second))
				result <- serveSOCKSFixture(connection, t)
			}()
			proxyURL, _ := ParseProxyURL(scheme + "://" + listener.Addr().String())
			policy, err := NewPolicy([]Destination{{URL: "http://source.test", AllowPrivate: true}}, Options{Proxy: proxyURL, Resolver: documentationTestResolver()})
			if err != nil {
				t.Fatal(err)
			}
			client := policy.Client(nil, 3*time.Second)
			defer client.CloseIdleConnections()
			response, err := client.Get("http://source.test/file")
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || string(body) != "pinned" {
				t.Fatalf("SOCKS response = %q, error = %v", body, err)
			}
			if err := <-result; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func serveSOCKSFixture(connection net.Conn, t *testing.T) error {
	var greeting [2]byte
	if _, err := io.ReadFull(connection, greeting[:]); err != nil {
		return err
	}
	methods := make([]byte, int(greeting[1]))
	if _, err := io.ReadFull(connection, methods); err != nil {
		return err
	}
	if _, err := connection.Write([]byte{5, 0}); err != nil {
		return err
	}
	var target [10]byte
	if _, err := io.ReadFull(connection, target[:]); err != nil {
		return err
	}
	if target[0] != 5 || target[1] != 1 || target[3] != 1 || !net.IP(target[4:8]).Equal(testfixture.DocumentationIPv4()) || binary.BigEndian.Uint16(target[8:]) != 80 {
		t.Errorf("SOCKS received a destination other than the validated numeric address: %v", target)
	}
	if _, err := connection.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80}); err != nil {
		return err
	}
	request, err := http.ReadRequest(bufio.NewReader(connection))
	if err != nil {
		return err
	}
	defer func() { _ = request.Body.Close() }()
	if request.Host != "source.test" {
		t.Errorf("tunneled Host = %q", request.Host)
	}
	response := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("pinned")), ContentLength: 6, Close: true}
	return response.Write(connection)
}
