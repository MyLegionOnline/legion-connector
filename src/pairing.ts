// REST calls against /api/v1/connectors — matches
// backend/app/api/v1/connectors.py and backend/app/schemas/connector.py
// exactly (field names, status codes). The WS endpoint only ever sees a
// short-lived access-JWT; the refresh token never touches connector_ws.py.

export interface PairResult {
  connector_id: string;
  refresh_token: string;
}

export interface TokenResult {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function restBaseUrl(hubUrl: string): string {
  // hub_url in connector.toml is the WS URL (…/api/v1/connector/ws); the
  // pairing/token REST endpoints live one segment up, at …/api/v1/connectors.
  const wsUrl = new URL(hubUrl);
  const httpProtocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  const apiRoot = wsUrl.pathname.replace(/\/connector\/ws\/?$/, "");
  return `${httpProtocol}//${wsUrl.host}${apiRoot}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) detail = data.detail;
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new PairingError(detail, res.status);
  }
  return (await res.json()) as T;
}

export async function pairWithCode(hubUrl: string, pairingCode: string): Promise<PairResult> {
  const base = restBaseUrl(hubUrl);
  return postJson<PairResult>(`${base}/connectors/pair`, { pairing_code: pairingCode });
}

export async function refreshAccessToken(
  hubUrl: string,
  refreshToken: string,
): Promise<TokenResult> {
  const base = restBaseUrl(hubUrl);
  return postJson<TokenResult>(`${base}/connectors/token`, { refresh_token: refreshToken });
}
