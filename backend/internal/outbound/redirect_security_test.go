package outbound

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRedirectCredentialsRemainRemovedAfterCrossingOrigin(t *testing.T) {
	var origin *httptest.Server
	checkStripped := func(request *http.Request) {
		for _, name := range []string{"Authorization", "Cookie", "Proxy-Authorization", "Referer"} {
			if request.Header.Get(name) != "" {
				t.Errorf("%s restored at %s", name, request.URL.Path)
			}
		}
	}
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		checkStripped(request)
		if request.URL.Path == "/first" {
			http.Redirect(w, request, "/second", http.StatusFound)
		} else {
			http.Redirect(w, request, origin.URL+"/return", http.StatusFound)
		}
	}))
	defer destination.Close()
	origin = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/return" {
			checkStripped(request)
			_, _ = io.WriteString(w, "ok")
			return
		}
		if request.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("initial authorized request lost its credentials")
		}
		http.Redirect(w, request, destination.URL+"/first", http.StatusFound)
	}))
	defer origin.Close()
	policy, err := NewPolicy([]Destination{{URL: origin.URL, AllowPrivate: true}, {URL: destination.URL, AllowPrivate: true}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodGet, origin.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer synthetic-token")
	request.Header.Set("Cookie", "session=synthetic")
	request.Header.Set("Proxy-Authorization", "Basic synthetic")
	request.Header.Set("Referer", origin.URL+"/private")
	client := policy.Client(nil, time.Second)
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("redirect chain status = %d", response.StatusCode)
	}
}
