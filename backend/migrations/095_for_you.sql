-- For you in Discover draws small sets of the account's local works with the
-- recommendation affinity profile. The account chooses one temperature for its
-- draws; NULL is the default, Balanced.
ALTER TABLE user_preference ADD COLUMN for_you_temperature TEXT CHECK(for_you_temperature IN ('safe', 'balanced', 'adventurous'));

-- Recommendation events name the surface that showed the work, so For you
-- impressions and opens rotate its draws without entering the Library's
-- recommendation activity.
ALTER TABLE recommendation_event ADD COLUMN surface TEXT NOT NULL DEFAULT 'library' CHECK(surface IN ('library', 'for_you'));

CREATE INDEX idx_recommendation_event_user_surface_created
  ON recommendation_event(user_id, surface, created_at DESC);
