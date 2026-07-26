package httpapi

type creatorLatestWork struct {
	PrimaryCode string  `json:"primaryCode"`
	Title       string  `json:"title"`
	ReleaseDate *string `json:"releaseDate"`
	CoverURL    string  `json:"coverUrl"`
}

func creatorPageBounds(page int, pageSize int, total int) (int, int, int) {
	if pageSize < 1 {
		pageSize = 24
	}
	if pageSize > 100 {
		pageSize = 100
	}
	lastPage := 1
	if total > 0 {
		lastPage = (total + pageSize - 1) / pageSize
	}
	if page < 1 {
		page = 1
	}
	if page > lastPage {
		page = lastPage
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}
	return page, start, end
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
