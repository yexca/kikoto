package account

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/argon2"
)

// New hashes use the OWASP m=19 MiB, t=2, p=1 Argon2id configuration. Stored
// hashes with other parameters still verify and are upgraded after the next
// successful password check.
const (
	argon2idMemory      uint32 = 19 * 1024
	argon2idIterations  uint32 = 2
	argon2idParallelism uint8  = 1
	maxArgon2idMemory   uint32 = 256 * 1024
	maxArgon2idTime     uint32 = 10
	maxArgon2idKeyLen   uint32 = 64
	passwordSaltLength         = 16
	passwordKeyLength          = 32

	// DefaultPasswordCheckConcurrency bounds concurrent Argon2id derivations
	// unless SetPasswordCheckConcurrency overrides it. Eight current-parameter
	// derivations peak near 152 MiB.
	DefaultPasswordCheckConcurrency = 8
)

// A sign-in that cannot obtain a derivation slot within this time fails as
// busy rather than queueing indefinitely behind a login flood.
var argon2idSlotWait = 5 * time.Second

// ErrPasswordVerificationBusy reports that every password derivation slot
// stayed occupied for the bounded wait.
var ErrPasswordVerificationBusy = errors.New("password verification is busy")

// Every Argon2id derivation allocates its full memory cost, so concurrent
// derivations share a fixed pool instead of scaling with request volume.
var argon2idSlots atomic.Pointer[chan struct{}]

func init() {
	SetPasswordCheckConcurrency(DefaultPasswordCheckConcurrency)
}

// SetPasswordCheckConcurrency sets how many Argon2id derivations (sign-ins,
// password changes, and new passwords) may run at once. Values below one use
// one. It is meant for startup; a derivation already running releases its slot
// to the pool it acquired.
func SetPasswordCheckConcurrency(limit int) {
	slots := make(chan struct{}, max(1, limit))
	argon2idSlots.Store(&slots)
}

// dummyPasswordHash is verified when a sign-in names no usable credential, so
// an unknown username costs the same derivation as a wrong password. Its random
// key matches no password.
var dummyPasswordHash = sync.OnceValues(func() (string, error) {
	salt := make([]byte, passwordSaltLength)
	key := make([]byte, passwordKeyLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return encodeArgon2idHash(salt, key), nil
})

var currentArgon2idParams = argon2idParams{memory: argon2idMemory, iterations: argon2idIterations, parallelism: argon2idParallelism}

func HashPassword(password string) (string, error) {
	return hashPasswordContext(context.Background(), password)
}

func hashPasswordContext(ctx context.Context, password string) (string, error) {
	salt := make([]byte, passwordSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum, err := deriveArgon2idKey(ctx, password, salt, currentArgon2idParams, passwordKeyLength)
	if err != nil {
		return "", err
	}
	return encodeArgon2idHash(salt, sum), nil
}

func encodeArgon2idHash(salt []byte, key []byte) string {
	return fmt.Sprintf(
		"argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argon2idMemory, argon2idIterations, argon2idParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key),
	)
}

// passwordNeedsRehash reports whether a stored hash differs from the format
// HashPassword produces now.
func passwordNeedsRehash(encoded string) bool {
	hash, ok := decodeArgon2idHash(encoded)
	return !ok || hash.params != currentArgon2idParams || len(hash.salt) != passwordSaltLength || len(hash.key) != passwordKeyLength
}

func VerifyPassword(password string, encoded string) bool {
	matched, err := verifyPasswordContext(context.Background(), password, encoded)
	return err == nil && matched
}

func verifyPasswordContext(ctx context.Context, password string, encoded string) (bool, error) {
	hash, ok := decodeArgon2idHash(encoded)
	if !ok {
		return false, nil
	}
	actual, err := deriveArgon2idKey(ctx, password, hash.salt, hash.params, uint32(len(hash.key)))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(actual, hash.key) == 1, nil
}

func deriveArgon2idKey(ctx context.Context, password string, salt []byte, params argon2idParams, keyLength uint32) ([]byte, error) {
	slots := *argon2idSlots.Load()
	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-slots }()
	return argon2.IDKey([]byte(password), salt, params.iterations, params.memory, params.parallelism, keyLength), nil
}

type argon2idHash struct {
	params argon2idParams
	salt   []byte
	key    []byte
}

func decodeArgon2idHash(encoded string) (argon2idHash, bool) {
	if !strings.HasPrefix(encoded, "argon2id$") {
		return argon2idHash{}, false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" {
		return argon2idHash{}, false
	}
	version, ok := strings.CutPrefix(parts[1], "v=")
	if !ok {
		return argon2idHash{}, false
	}
	versionNumber, err := strconv.Atoi(version)
	if err != nil || versionNumber != argon2.Version {
		return argon2idHash{}, false
	}
	params, err := parseArgon2idParams(parts[2])
	if err != nil {
		return argon2idHash{}, false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return argon2idHash{}, false
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(key) == 0 || uint32(len(key)) > maxArgon2idKeyLen {
		return argon2idHash{}, false
	}
	return argon2idHash{params: params, salt: salt, key: key}, true
}

type argon2idParams struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
}

func parseArgon2idParams(encoded string) (argon2idParams, error) {
	params := argon2idParams{}
	for _, part := range strings.Split(encoded, ",") {
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			return argon2idParams{}, errors.New("invalid argon2id params")
		}
		number, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return argon2idParams{}, err
		}
		switch key {
		case "m":
			params.memory = uint32(number)
		case "t":
			params.iterations = uint32(number)
		case "p":
			if number > 255 {
				return argon2idParams{}, errors.New("argon2id parallelism is too large")
			}
			params.parallelism = uint8(number)
		default:
			return argon2idParams{}, errors.New("unknown argon2id param")
		}
	}
	if params.memory == 0 || params.iterations == 0 || params.parallelism == 0 {
		return argon2idParams{}, errors.New("missing argon2id param")
	}
	if params.memory > maxArgon2idMemory || params.iterations > maxArgon2idTime {
		return argon2idParams{}, errors.New("argon2id params are too large")
	}
	return params, nil
}
