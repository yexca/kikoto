package httpapi

import "context"

type remoteFetchEditionKey struct{}

// withRemoteFetchEdition carries the caller's selected local identity separately
// from the source code in the route. It never grants authority to create an alias.
func withRemoteFetchEdition(ctx context.Context, editionCode string) context.Context {
	return context.WithValue(ctx, remoteFetchEditionKey{}, normalizeWorkCode(editionCode))
}

func requireRemoteFetchEdition(ctx context.Context, actualCode string) error {
	expected, _ := ctx.Value(remoteFetchEditionKey{}).(string)
	if expected != "" && expected != normalizeWorkCode(actualCode) {
		return invalidRequestError("remote work does not resolve to the selected local edition")
	}
	return nil
}
