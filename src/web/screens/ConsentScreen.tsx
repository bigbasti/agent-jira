import {useEffect, useId, useMemo, useState, type ReactNode} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {Wordmark} from '../components/Wordmark.js';
import {Button} from '../components/ui/Button.js';
import {Input} from '../components/ui/Input.js';
import {ApiError, api} from '../lib/api.js';

/**
 * The OAuth consent screen.
 *
 * This is a security decision, so it is built like one: a full page the user arrived at
 * deliberately, never an overlay that can be dismissed by accident or clicked through.
 * There is no marketing copy and nothing to scroll past — who is asking, what they will
 * be able to do, where the grant will be sent, and two answers.
 *
 * Everything shown about the requester is fetched from the server by `client_id`, never
 * read out of the query string, so a hand-crafted `/consent?...` link cannot dress one
 * client up as another. The name itself is attacker-controlled text from dynamic
 * registration: React renders it as text (so markup is inert), the server has already
 * stripped control and bidi characters and capped its length, and it is boxed and
 * wrapped here so it cannot be mistaken for this page's own chrome.
 */

interface Permission {
  id: string;
  label: string;
}

interface ConsentDescription {
  clientId: string;
  clientName: string;
  redirectUri: string;
  permissions: Permission[];
  defaultAgentName: string;
  maxAgentNameLength: number;
}

export interface ConsentScreenProps {
  /** The query string carrying the authorization request. Injected in tests. */
  search?: string;
  /** How the browser leaves for the client's callback. Injected in tests. */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

export function ConsentScreen({search, navigate = defaultNavigate}: ConsentScreenProps = {}) {
  const query = search ?? window.location.search;
  const path = `/consent${query.startsWith('?') || query === '' ? query : `?${query}`}`;
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(query)), [query]);
  const headingId = useId();

  const request = useQuery({
    queryKey: ['oauth-consent', query],
    queryFn: () => api.get<ConsentDescription>(`/api/oauth/consent${path.slice('/consent'.length)}`),
    retry: false,
    staleTime: Infinity,
  });

  const [typedName, setTypedName] = useState<string | null>(null);
  const agentName = typedName ?? request.data?.defaultAgentName ?? '';

  const decide = useMutation({
    mutationFn: (decision: 'allow' | 'deny') =>
      // JSON by design: a cross-origin HTML form cannot send this content type, so a
      // hostile page cannot press Allow with the user's cookie riding along.
      api.post<{redirectTo: string}>('/oauth/authorize', {...params, decision, agent_name: agentName}),
    onSuccess: result => navigate(result.redirectTo),
  });

  const sessionEnded = request.error instanceof ApiError && request.error.status === 401;

  // A session that lapsed between the redirect and this render: sign in, then come back
  // to this exact request rather than landing on the board with the flow half-finished.
  useEffect(() => {
    if (!sessionEnded) return;
    navigate(`/?next=${encodeURIComponent(path)}`);
  }, [sessionEnded, path, navigate]);

  if (request.isPending || sessionEnded) {
    return (
      <Shell>
        <section className="rounded-card border border-hairline bg-surface p-5">
          <h1 className="text-lede font-semibold text-text">Checking this request…</h1>
          <p className="mt-2 text-body text-muted">Nothing is approved until you say so.</p>
        </section>
      </Shell>
    );
  }

  if (request.isError) {
    return (
      <Shell>
        <section className="rounded-card border border-hairline bg-surface p-5">
          <h1 className="text-lede font-semibold text-text">Can&rsquo;t authorize this request</h1>
          <p className="mt-2 text-body text-muted">{describeFailure(request.error)}</p>
          <p className="mt-2 text-body text-muted">
            Nothing was granted. Start the connection again from the application that sent you here.
          </p>
        </section>
      </Shell>
    );
  }

  const description = request.data;

  return (
    <Shell>
      <section aria-labelledby={headingId} className="rounded-card border border-hairline bg-surface p-5">
        <h1 id={headingId} className="text-title font-semibold text-text">
          Authorize board access
        </h1>
        <p className="mt-2 text-body text-muted">
          An application is asking to work on your board as an agent. Approve it only if you started this.
        </p>

        <dl className="mt-5 flex flex-col gap-3 rounded-well border border-hairline bg-well px-3 py-3">
          <Field label="Requesting application">
            {/* Untrusted text: boxed, wrapped, and never allowed to choose its own size. */}
            <span className="block break-words text-body font-medium text-text">{description.clientName}</span>
          </Field>
          <Field label="Codes will be sent to">
            <span className="block break-all font-mono text-label text-muted">{description.redirectUri}</span>
          </Field>
        </dl>

        <h2 className="mt-5 text-label font-medium text-muted">It will be able to</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {description.permissions.map(permission => (
            <li key={permission.id} className="flex items-start gap-2.5 text-body text-text">
              <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 rounded-[1px] bg-hairline-strong" />
              {permission.label}
            </li>
          ))}
        </ul>

        <div className="mt-5">
          <Input
            label="Agent name"
            value={agentName}
            maxLength={description.maxAgentNameLength}
            spellCheck={false}
            hint="How this agent will be listed on your board."
            onChange={event => setTypedName(event.target.value)}
          />
        </div>

        {decide.isError && (
          <p role="alert" className="mt-4 rounded-well border border-rose/35 bg-rose-wash px-3 py-2 text-label text-rose">
            {describeFailure(decide.error)}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
            Deny
          </Button>
          <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate('allow')}>
            {decide.isPending ? 'Working…' : 'Allow'}
          </Button>
        </div>
      </section>
    </Shell>
  );
}

/** The page frame. Always the same, so the decision never moves under the user. */
function Shell({children}: {children: ReactNode}) {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div aria-hidden="true" className="drafting-grid pointer-events-none absolute inset-0" />
      <div className="relative w-full max-w-[26rem]">
        <header className="mb-6 px-1">
          <Wordmark size="bar" />
        </header>
        {children}
      </div>
    </main>
  );
}

function Field({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-micro font-medium tracking-wide text-muted uppercase">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

function describeFailure(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}
