import { Page } from '../shell/Shell';
import { Card, Empty } from '../shell/ui';
import { CLIENT, THINGS_ALIVE } from '../shell/nav';

/**
 * A screen that is on the rail because the capability is real, and is not built yet.
 *
 * It names the route it will read. That is the same discipline the design canvas
 * holds to — a screen with no API behind it should be visibly missing rather than
 * quietly mocked, because a mock that looks finished is how a demo promises something
 * the platform cannot do.
 */
export function Planned({ path }: { path: string }) {
  const item = [...THINGS_ALIVE, ...CLIENT].find((i) => i.path === path);
  return (
    <Page title={item?.label ?? 'Not built yet'}>
      <Card>
        <Empty title="Not built yet">
          This screen is on your rail because you hold <code className="font-mono">{item?.needs}</code>,
          and it will read <code className="font-mono">{item?.route}</code>. Nothing is mocked here on
          purpose.
        </Empty>
      </Card>
    </Page>
  );
}
