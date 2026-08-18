'use client';

import { mcpInfoSchema, type McpInfo } from '@hatko/shared';
import { useApi } from '../../../../lib/use-api.ts';
import {
  AlertIcon,
  Badge,
  ErrorCard,
  Eyebrow,
  LabelFrame,
  SkeletonLine,
} from '../../../../components/ui.tsx';

/**
 * What the MCP server is, where it is, and whether it is answering.
 *
 * It runs as a separate process on its own port, so nothing about it shows up elsewhere in
 * the app: not the endpoint it advertises, not the hostnames it will answer to, not whether
 * it is running at all. That used to live in a startup banner you could only read over SSH,
 * and a misconfiguration there went unnoticed through an entire deployment.
 *
 * The host list is the part worth having on a page. The rebinding guard runs after the
 * bearer check, so an unauthenticated probe gets a 401 whether or not the public hostname
 * is configured. The mistake only shows up later, as a 403 for every real client at once,
 * and reading this list is the only way to catch it before that.
 */

const STATUS: Record<
  McpInfo['status'],
  { label: string; tone: 'brand' | undefined; note: string }
> = {
  authenticating: {
    label: 'answering',
    tone: 'brand',
    note: 'An unauthenticated request gets a challenge back. That is the healthy response, and it is what starts the OAuth flow in a client.',
  },
  unexpected: {
    label: 'unexpected reply',
    tone: undefined,
    note: 'Something answered, but not the MCP server. Check that the reverse proxy routes /mcp to it.',
  },
  unreachable: {
    label: 'not answering',
    tone: undefined,
    note: 'Nothing answered at this address. Check that the MCP process is running.',
  },
};

export function McpView() {
  const info = useApi('/api/admin/mcp', mcpInfoSchema);

  if (info.error) {
    return (
      <ErrorCard
        title="Could not read the MCP configuration."
        detail={info.error}
        onRetry={info.reload}
      />
    );
  }

  if (!info.data) {
    return (
      <LabelFrame title={<Eyebrow as="h2">MCP server</Eyebrow>}>
        <SkeletonLine className="w-1/2" />
        <SkeletonLine className="mt-3 w-full" />
        <SkeletonLine className="mt-3 w-2/3" />
      </LabelFrame>
    );
  }

  const { url, discovery, allowedHosts, tool, rateLimit, status, statusDetail } = info.data;
  const state = STATUS[status];

  return (
    <div className="grid gap-6">
      <LabelFrame title={<Eyebrow as="h2">MCP server</Eyebrow>}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone}>{state.label}</Badge>
          <span className="text-mono break-all font-mono text-text-muted">{url}</span>
        </div>
        <p className="mt-3 max-w-[68ch] text-body-sm text-text-muted">{state.note}</p>
        {statusDetail && (
          <p className="mt-2 flex items-start gap-1.5 text-body-sm text-text">
            <AlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{statusDetail}</span>
          </p>
        )}

        <dl className="mt-4 grid gap-1 border-t border-rule pt-4 text-body-sm text-text-muted">
          <Row label="tool">{tool.name}</Row>
          <Row label="query">up to {tool.queryMaxChars} characters</Row>
          <Row label="passages">1 to {tool.limitMax} per call</Row>
          <Row label="allowance">
            {rateLimit.max === 0
              ? 'disabled (RATE_LIMIT_MAX=0)'
              : `${rateLimit.max} tool calls per ${rateLimit.windowSeconds}s per account`}
          </Row>
        </dl>
      </LabelFrame>

      <LabelFrame title={<Eyebrow as="h3">Accepted Host headers</Eyebrow>}>
        <p className="max-w-[68ch] text-body-sm text-text-muted">
          The MCP server refuses a <span className="font-mono">Host</span> it does not recognise,
          which closes the DNS-rebinding path a browser could otherwise use against a local port.
          Behind a reverse proxy the arriving host is your public hostname, so it has to be in this
          list or every authenticated client gets a 403.
        </p>
        <p className="mt-2 max-w-[68ch] text-body-sm text-text-muted">
          You cannot test this by calling the endpoint. The check runs after authentication, so an
          anonymous request is refused the same way whether the hostname is listed or not. Read the
          list below instead.
        </p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {allowedHosts.map((host) => (
            <li
              key={host}
              className="text-mono border border-rule bg-bg-sunken px-2 py-1 font-mono text-text"
            >
              {host}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-body-sm text-text-muted">
          Add more with <span className="font-mono">MCP_ALLOWED_HOSTS</span> in{' '}
          <span className="font-mono">.env</span>, comma separated, then restart the MCP process.
        </p>
      </LabelFrame>

      <LabelFrame title={<Eyebrow as="h3">Connecting a client</Eyebrow>}>
        <p className="max-w-[68ch] text-body-sm text-text-muted">
          Clients discover everything else from these two documents. The first names this endpoint
          as the protected resource, and the second names the authorization server.
        </p>
        <Commands lines={[discovery.protectedResource, discovery.authorizationServer]} />

        <p className="mt-4 max-w-[68ch] text-body-sm text-text-muted">
          Claude Code, which will send you to a Hatko consent screen naming the client:
        </p>
        <Commands lines={[`claude mcp add --transport http hatko ${url}`]} />

        <p className="mt-4 max-w-[68ch] text-body-sm text-text-muted">
          For a script or CI, a session bearer token works instead of the OAuth flow. Both paths
          land on the same permission check, so authorization is decided in one place.
          Full instructions are in <span className="font-mono">docs/mcp.md</span>.
        </p>
      </LabelFrame>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0">{label}</dt>
      <dd className="break-all font-mono text-text">{children}</dd>
    </div>
  );
}

/** A copyable block. Selectable text, not a fake terminal. */
function Commands({ lines }: { lines: string[] }) {
  return (
    <pre className="text-mono mt-2 overflow-x-auto border border-rule bg-bg p-2 font-mono text-text-muted">
      {lines.join('\n')}
    </pre>
  );
}
