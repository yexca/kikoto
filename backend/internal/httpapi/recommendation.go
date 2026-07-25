package httpapi

import "context"

func (s *Server) workRecommendationScore(ctx context.Context, userID, workID int64) (int, error) {
	return s.libraryStore.RecommendationScore(ctx, userID, workID)
}
