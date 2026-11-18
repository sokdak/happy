function firstHeaderToken(value: string | string[] | undefined): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return undefined;
    const token = raw.split(',')[0]?.trim();
    return token && token.length > 0 ? token : undefined;
}

/**
 * Build the base URL the client should use to reach our local-mode upload /
 * download endpoints. Prefer an explicit PUBLIC_URL, then x-forwarded-* (for
 * deployments behind one or more proxies), then the Host header the request
 * arrived on.
 */
export function resolveBaseUrl(request: { headers: Record<string, string | string[] | undefined> }): string {
    if (process.env.PUBLIC_URL) {
        return process.env.PUBLIC_URL.replace(/\/+$/, '');
    }
    const host = firstHeaderToken(request.headers['x-forwarded-host']) ?? firstHeaderToken(request.headers.host);
    let proto = firstHeaderToken(request.headers['x-forwarded-proto']) ?? 'http';
    if (proto === 'http' && firstHeaderToken(request.headers['x-forwarded-ssl']) === 'on') {
        proto = 'https';
    }
    if (host) {
        return `${proto}://${host}`;
    }
    return `http://localhost:${process.env.PORT || '3005'}`;
}
