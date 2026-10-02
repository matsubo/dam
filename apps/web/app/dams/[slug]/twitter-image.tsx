// Twitter card reuses the per-dam OG card, as app/twitter-image.tsx does for
// the site-wide one. Segment config must be a literal, not a re-export.
export {
  alt,
  contentType,
  default,
  size,
} from './opengraph-image.tsx';

export const dynamic = 'force-dynamic';
