UPDATE sonja_file_embedding_chunks
SET grade = CAST(
  REGEXP_SUBSTR(
    LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))),
    '(grade|graad|gr)[[:space:]]*\\.?[[:space:]]*([0-9]{1,2})',
    1,
    1,
    'c',
    2
  ) AS UNSIGNED
)
WHERE owner = 'sonja'
  AND grade IS NULL
  AND REGEXP_LIKE(LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))), '(grade|graad|gr)[[:space:]]*\\.?[[:space:]]*[0-9]{1,2}');

UPDATE sonja_file_embedding_chunks
SET subject = 'math'
WHERE owner = 'sonja'
  AND subject = 'unknown'
  AND REGEXP_LIKE(LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))), '(math|maths|mathematics|wiskunde|wisk|algebra|geometry|geometrie|fractions|optel|aftrek)');

UPDATE sonja_file_embedding_chunks
SET subject = 'afrikaans'
WHERE owner = 'sonja'
  AND subject = 'unknown'
  AND REGEXP_LIKE(LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))), '(^|[^a-z])(afrikaans|afr)([^a-z]|$)');

UPDATE sonja_file_embedding_chunks
SET subject = 'english'
WHERE owner = 'sonja'
  AND subject = 'unknown'
  AND REGEXP_LIKE(LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))), '(^|[^a-z])(english|eng)([^a-z]|$)');

UPDATE sonja_file_embedding_chunks
SET subject = 'science'
WHERE owner = 'sonja'
  AND subject = 'unknown'
  AND REGEXP_LIKE(LOWER(CONCAT(COALESCE(summary, ''), ' ', COALESCE(filename, ''))), '(science|natuurwetenskap|natural sciences|(^|[^a-z])nst([^a-z]|$))');
