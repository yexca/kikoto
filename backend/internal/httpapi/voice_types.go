package httpapi

const voiceRemotePageSize = 48
const unknownVoiceActorName = "unknown"

type voiceSummary struct {
	PersonID        int64              `json:"personId"`
	DisplayName     string             `json:"displayName"`
	Aliases         []string           `json:"aliases"`
	KnownWorks      int                `json:"knownWorks"`
	LocalWorks      int                `json:"localWorks"`
	RemoteWorks     int                `json:"remoteWorks"`
	CachedWorks     int                `json:"cachedWorks"`
	PlayableWorks   int                `json:"playableWorks"`
	LastSeenAt      *string            `json:"lastSeenAt"`
	LastSyncedAt    *string            `json:"lastSyncedAt"`
	SyncState       string             `json:"syncState"`
	SyncReason      string             `json:"syncReason"`
	Rating          *int               `json:"rating"`
	Note            string             `json:"note"`
	Favorite        bool               `json:"favorite"`
	UserTags        []voiceUserTag     `json:"userTags"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
	LatestWork      *creatorLatestWork `json:"latestWork"`
}

type voiceSummaryPage struct {
	Voices     []voiceSummary `json:"voices"`
	Page       int            `json:"page"`
	PageSize   int            `json:"pageSize"`
	Total      int            `json:"total"`
	TagOptions []string       `json:"tagOptions"`
}

type voiceUserTag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type voiceAlias struct {
	ID        int64  `json:"id"`
	Alias     string `json:"alias"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type voiceAliasCandidate struct {
	PersonID    int64        `json:"personId"`
	DisplayName string       `json:"displayName"`
	Aliases     []voiceAlias `json:"aliases"`
	KnownWorks  int          `json:"knownWorks"`
	LocalWorks  int          `json:"localWorks"`
	RemoteWorks int          `json:"remoteWorks"`
}

type voiceMergeReview struct {
	ID             int64  `json:"id"`
	TargetPersonID int64  `json:"targetPersonId"`
	SourcePersonID int64  `json:"sourcePersonId"`
	TargetName     string `json:"targetName"`
	SourceName     string `json:"sourceName"`
	Status         string `json:"status"`
	CreatedAt      string `json:"createdAt"`
	UndoneAt       string `json:"undoneAt"`
}

type personMergeSnapshot struct {
	SourcePerson    personSnapshot              `json:"sourcePerson"`
	Aliases         []personAliasSnapshot       `json:"aliases"`
	Credits         []workCreditSnapshot        `json:"credits"`
	States          []userPersonStateSnapshot   `json:"states"`
	TagLinks        []userPersonTagLinkSnapshot `json:"tagLinks"`
	TargetCredits   []workCreditSnapshot        `json:"targetCredits"`
	TargetStates    []userPersonStateSnapshot   `json:"targetStates"`
	TargetTagLinks  []userPersonTagLinkSnapshot `json:"targetTagLinks"`
	AddedAliases    []string                    `json:"addedAliases"`
	ExternalIDs     []personExternalIDSnapshot  `json:"externalIds,omitempty"`
	CatalogCaptured bool                        `json:"catalogCaptured,omitempty"`
	SourceCatalog   voiceCatalogPersonSnapshot  `json:"sourceCatalog,omitempty"`
	TargetCatalog   voiceCatalogPersonSnapshot  `json:"targetCatalog,omitempty"`
}

type personSnapshot struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"displayName"`
	SortName    string `json:"sortName"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type personAliasSnapshot struct {
	Alias     string `json:"alias"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type personExternalIDSnapshot struct {
	ProviderID int64  `json:"providerId"`
	IDType     string `json:"idType"`
	ExternalID string `json:"externalId"`
	IsPrimary  bool   `json:"isPrimary"`
}

type workCreditSnapshot struct {
	WorkID     int64  `json:"workId"`
	Role       string `json:"role"`
	ProviderID *int64 `json:"providerId"`
	Source     string `json:"source"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type userPersonStateSnapshot struct {
	UserID       int64   `json:"userId"`
	Rating       *int    `json:"rating"`
	Note         string  `json:"note"`
	Favorite     bool    `json:"favorite"`
	LastViewedAt *string `json:"lastViewedAt"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type userPersonTagLinkSnapshot struct {
	UserID          int64  `json:"userId"`
	UserPersonTagID int64  `json:"userPersonTagId"`
	CreatedAt       string `json:"createdAt"`
}

type voiceDetail struct {
	voiceSummary
	Works         []voiceKnownWork       `json:"works"`
	RemoteMatches []voiceRemoteSourceSet `json:"remoteMatches"`
	// MetadataMissingWorks counts known catalog works without a provider
	// snapshot; an incremental metadata refresh targets exactly these.
	MetadataMissingWorks int `json:"metadataMissingWorks"`
}

type voiceKnownWork struct {
	WorkID             int64                    `json:"workId"`
	PrimaryCode        string                   `json:"primaryCode"`
	RemoteCode         string                   `json:"remoteCode"`
	Title              string                   `json:"title"`
	ReleaseDate        *string                  `json:"releaseDate"`
	UpdatedAt          string                   `json:"updatedAt"`
	CoverURL           string                   `json:"coverUrl"`
	DLsiteURL          string                   `json:"dlsiteUrl"`
	Circle             string                   `json:"circle"`
	CircleExternalID   string                   `json:"circleExternalId"`
	AgeRating          string                   `json:"ageRating"`
	Rating             *float64                 `json:"rating"`
	RatingCount        *int64                   `json:"ratingCount"`
	Sales              *int64                   `json:"sales"`
	HasLyrics          bool                     `json:"hasLyrics,omitempty"`
	RegularPrice       *int64                   `json:"regularPrice"`
	Price              *int64                   `json:"price"`
	PriceCurrency      string                   `json:"priceCurrency"`
	PermanentlyFree    *bool                    `json:"permanentlyFree"`
	Tags               []string                 `json:"tags"`
	UserTags           []workUserTag            `json:"userTags"`
	VoiceActors        []string                 `json:"voiceActors"`
	VoiceCredits       []voiceCredit            `json:"voiceCredits"`
	Series             string                   `json:"series"`
	SeriesTitleID      string                   `json:"seriesTitleId"`
	ListeningMark      string                   `json:"listeningMark"`
	Favorite           bool                     `json:"favorite"`
	Local              bool                     `json:"local"`
	Remote             bool                     `json:"remote"`
	Cache              bool                     `json:"cache"`
	SourceTags         []circleSourceStat       `json:"sourceTags"`
	RemoteObservations []voiceRemoteObservation `json:"remoteObservations"`
	Progress           workProgressSummary      `json:"progress"`
}

type voiceRemoteObservation struct {
	SourceID   int64  `json:"sourceId"`
	SourceCode string `json:"sourceCode"`
	SourceName string `json:"sourceName"`
	RemoteCode string `json:"remoteCode"`
	Status     string `json:"status"`
}

type voiceRemoteSourceSet struct {
	SourceID    int64             `json:"sourceId"`
	SourceCode  string            `json:"sourceCode"`
	DisplayName string            `json:"displayName"`
	Status      string            `json:"status"`
	Error       string            `json:"error"`
	DebugError  string            `json:"-"`
	ElapsedMS   int64             `json:"elapsedMs"`
	Total       int               `json:"total"`
	Works       []voiceRemoteWork `json:"works"`
}

type voiceRemoteWork struct {
	SourceID       int64    `json:"sourceId"`
	SourceCode     string   `json:"sourceCode"`
	SourceName     string   `json:"sourceName"`
	RemoteID       string   `json:"remoteId"`
	PrimaryCode    string   `json:"primaryCode"`
	RemoteCode     string   `json:"remoteCode"`
	Title          string   `json:"title"`
	ReleaseDate    string   `json:"releaseDate"`
	UpdatedAt      string   `json:"updatedAt"`
	CoverURL       string   `json:"coverUrl"`
	Circle         string   `json:"circle"`
	AgeRating      string   `json:"ageRating"`
	Rating         *float64 `json:"rating"`
	RatingCount    *int64   `json:"ratingCount"`
	Sales          *int64   `json:"sales"`
	HasLyrics      bool     `json:"hasLyrics,omitempty"`
	Price          *int64   `json:"price"`
	Tags           []string `json:"tags"`
	VoiceActors    []string `json:"voiceActors"`
	ImportStatus   string   `json:"importStatus"`
	RemotePlayable bool     `json:"remotePlayable"`
	WorkID         *int64   `json:"workId"`
	HasLocal       bool     `json:"hasLocal"`
	HasCache       bool     `json:"hasCache"`
	HasRemote      bool     `json:"hasRemote"`
	Availability   string   `json:"availability,omitempty"`
}
