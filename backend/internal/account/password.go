package account

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argon2idMemory      uint32 = 64 * 1024
	argon2idIterations  uint32 = 3
	argon2idParallelism uint8  = 1
	maxArgon2idMemory   uint32 = 256 * 1024
	maxArgon2idTime     uint32 = 10
	maxArgon2idKeyLen   uint32 = 64
	passwordSaltLength         = 16
	passwordKeyLength          = 32
)

func HashPassword(password string) (string, error) {
	salt := make([]byte, passwordSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey([]byte(password), salt, argon2idIterations, argon2idMemory, argon2idParallelism, passwordKeyLength)
	return fmt.Sprintf(
		"argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argon2idMemory, argon2idIterations, argon2idParallelism,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(sum),
	), nil
}

func VerifyPassword(password string, encoded string) bool {
	if !strings.HasPrefix(encoded, "argon2id$") {
		return false
	}
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" {
		return false
	}
	version, ok := strings.CutPrefix(parts[1], "v=")
	if !ok {
		return false
	}
	versionNumber, err := strconv.Atoi(version)
	if err != nil || versionNumber != argon2.Version {
		return false
	}
	params, err := parseArgon2idParams(parts[2])
	if err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(expected) == 0 || uint32(len(expected)) > maxArgon2idKeyLen {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, params.iterations, params.memory, params.parallelism, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1
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
