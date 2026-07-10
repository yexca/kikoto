package account

import (
	"strings"
	"testing"
)

func TestPasswordHashUsesArgon2idAndVerifies(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "argon2id$") {
		t.Fatalf("HashPassword() = %q, want argon2id format", hash)
	}
	if !VerifyPassword("correct horse battery staple", hash) {
		t.Fatal("VerifyPassword() rejected the correct password")
	}
	if VerifyPassword("wrong password", hash) {
		t.Fatal("VerifyPassword() accepted the wrong password")
	}
}

func TestVerifyPasswordRejectsExcessiveParameters(t *testing.T) {
	encoded := "argon2id$v=19$m=999999999,t=3,p=1$c2FsdA$aGFzaA"
	if VerifyPassword("password", encoded) {
		t.Fatal("VerifyPassword() accepted excessive memory parameters")
	}
}
