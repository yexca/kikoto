ALTER TABLE work ADD COLUMN rating_average REAL;
ALTER TABLE work ADD COLUMN sales_count INTEGER CHECK(sales_count IS NULL OR sales_count >= 0);
ALTER TABLE work ADD COLUMN regular_price INTEGER CHECK(regular_price IS NULL OR regular_price >= 0);
ALTER TABLE work ADD COLUMN current_price INTEGER CHECK(current_price IS NULL OR current_price >= 0);
ALTER TABLE work ADD COLUMN price_currency TEXT NOT NULL DEFAULT '';
ALTER TABLE work ADD COLUMN is_permanently_free INTEGER CHECK(is_permanently_free IS NULL OR is_permanently_free IN (0, 1));

WITH ranked_snapshot AS (
  SELECT
    snapshot.work_id,
    snapshot.snapshot_json,
    ROW_NUMBER() OVER (
      PARTITION BY snapshot.work_id
      ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
    ) AS rank
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
  WHERE provider.code = 'dlsite' AND snapshot.work_id IS NOT NULL
), latest_value AS (
  SELECT
    work_id,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.rate_average_2dp'),
      json_extract(snapshot_json, '$.dynamic.rate_average'),
      json_extract(snapshot_json, '$.product.rate_average_2dp'),
      json_extract(snapshot_json, '$.product.rate_average'),
      json_extract(snapshot_json, '$.rate_average_2dp'),
      json_extract(snapshot_json, '$.rate_average')
    ) AS rating_average,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.dl_count'),
      json_extract(snapshot_json, '$.dynamic.download_count'),
      json_extract(snapshot_json, '$.dynamic.sales_count'),
      json_extract(snapshot_json, '$.product.dl_count'),
      json_extract(snapshot_json, '$.product.download_count'),
      json_extract(snapshot_json, '$.product.sales_count'),
      json_extract(snapshot_json, '$.dl_count'),
      json_extract(snapshot_json, '$.download_count'),
      json_extract(snapshot_json, '$.sales_count')
    ) AS sales_count,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.official_price'),
      json_extract(snapshot_json, '$.product.official_price'),
      json_extract(snapshot_json, '$.official_price')
    ) AS regular_price,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.price'),
      json_extract(snapshot_json, '$.product.price'),
      json_extract(snapshot_json, '$.price')
    ) AS current_price,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.discount_rate'),
      json_extract(snapshot_json, '$.product.discount_rate'),
      json_extract(snapshot_json, '$.discount_rate'),
      0
    ) AS discount_rate,
    COALESCE(
      json_extract(snapshot_json, '$.dynamic.is_discount'),
      json_extract(snapshot_json, '$.product.is_discount'),
      json_extract(snapshot_json, '$.is_discount'),
      0
    ) AS is_discount
  FROM ranked_snapshot
  WHERE rank = 1
)
UPDATE work
SET
  rating_average = (SELECT CAST(value.rating_average AS REAL) FROM latest_value AS value WHERE value.work_id = work.id),
  sales_count = (SELECT CAST(value.sales_count AS INTEGER) FROM latest_value AS value WHERE value.work_id = work.id),
  regular_price = (SELECT CAST(value.regular_price AS INTEGER) FROM latest_value AS value WHERE value.work_id = work.id),
  current_price = (SELECT CAST(value.current_price AS INTEGER) FROM latest_value AS value WHERE value.work_id = work.id),
  price_currency = CASE
    WHEN EXISTS (
      SELECT 1 FROM latest_value AS value
      WHERE value.work_id = work.id AND (value.regular_price IS NOT NULL OR value.current_price IS NOT NULL)
    ) THEN 'JPY'
    ELSE ''
  END,
  is_permanently_free = (
    SELECT CASE
      WHEN value.regular_price IS NULL OR value.current_price IS NULL THEN NULL
      WHEN CAST(value.regular_price AS INTEGER) = 0
        AND CAST(value.current_price AS INTEGER) = 0
        AND CAST(value.discount_rate AS INTEGER) = 0
        AND CAST(value.is_discount AS INTEGER) = 0
      THEN 1
      ELSE 0
    END
    FROM latest_value AS value
    WHERE value.work_id = work.id
  )
WHERE EXISTS (SELECT 1 FROM latest_value AS value WHERE value.work_id = work.id);

CREATE INDEX idx_work_demo_eligibility
  ON work(is_permanently_free, age_rating, id);

CREATE INDEX idx_work_rating_average
  ON work(rating_average DESC, id DESC);

CREATE INDEX idx_work_sales_count
  ON work(sales_count DESC, id DESC);
