const REVIEW_MODE = true

function isReviewMode() {
  return REVIEW_MODE
}

function filterReviewHomeEntries(entries = []) {
  if (!REVIEW_MODE) return entries
  const allowedTargets = new Set(["primary", "secondary", "product", "productList", "none"])
  return (entries || []).filter(entry => allowedTargets.has(entry.targetType || entry.linkType || "primary"))
}

module.exports = {
  REVIEW_MODE,
  isReviewMode,
  filterReviewHomeEntries
}
