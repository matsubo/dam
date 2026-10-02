/**
 * Serialise structured data for a `<script type="application/ld+json">` body.
 * JSON.stringify leaves `<` alone, so a dam name scraped from an upstream that
 * contained `</script>` would close the tag and inject markup. `<` is the
 * same character to a JSON parser.
 */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
