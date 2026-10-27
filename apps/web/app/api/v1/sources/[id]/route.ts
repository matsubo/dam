import { sourceDams, sourceSummary } from '@dam/db/repo/source_summary';
import { asProblem, HttpError } from '../../../../../lib/api/error.ts';
import { hal } from '../../../../../lib/api/response.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: rawId } = await params;
    const id = decodeURIComponent(rawId);
    const summary = await sourceSummary(id);
    if (!summary) throw new HttpError(404, 'Source not found');
    const dams = (await sourceDams(id)).map((d) => ({ ...d, id: d.id.toString() }));
    return hal(
      { ...summary, dams },
      {
        self: { href: `/api/v1/sources/${encodeURIComponent(id)}` },
        index: { href: '/api/v1/sources' },
        web: { href: `/sources/${encodeURIComponent(id)}` },
      },
    );
  } catch (e) {
    return asProblem(e);
  }
}
