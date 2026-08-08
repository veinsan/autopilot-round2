import { getSession } from 'next-auth/react'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8001'
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ''

function formatValidationItem(item: unknown): string | null {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null

  const entry = item as Record<string, unknown>
  const message = typeof entry.msg === 'string' ? entry.msg : null
  if (!message) return null

  const location = Array.isArray(entry.loc)
    ? entry.loc
        .filter((part) => typeof part === 'string' || typeof part === 'number')
        .join('.')
    : ''
  return location ? `${location}: ${message}` : message
}

export function formatApiErrorDetail(detail: unknown): string {
  if (typeof detail === 'string' && detail.trim()) return detail

  if (Array.isArray(detail)) {
    const messages = detail.map(formatValidationItem).filter(Boolean)
    if (messages.length > 0) return messages.join('; ')
  }

  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const objectDetail = detail as Record<string, unknown>
    const validationErrors = objectDetail.validation_errors
    if (Array.isArray(validationErrors)) {
      const messages = validationErrors
        .map(formatValidationItem)
        .filter(Boolean)
      if (messages.length > 0) {
        return `Policy validation failed: ${messages.join('; ')}`
      }
    }

    if (
      typeof objectDetail.message === 'string' &&
      objectDetail.message.trim()
    ) {
      return objectDetail.message
    }
  }

  return 'An API error occurred.'
}

/**
 * Error thrown for any non-2xx API response.
 *
 * `message` stays exactly what it was before this class existed (the readable
 * detail), so every `error instanceof Error` / `error.message` call site keeps
 * working. `status` is added so a screen can translate a specific backend
 * refusal into its own wording instead of showing the raw detail.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(status: number, message: string, detail: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/**
 * The request never reached the server: DNS, connection refused, a blocked
 * cross-origin request, or the machine being offline. Distinct from `ApiError`,
 * which means the server answered and refused.
 */
export class NetworkError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('The request could not be sent to the server.')
    this.name = 'NetworkError'
    this.cause = cause
  }
}

/**
 * The server answered successfully but the body was not the JSON we expected.
 * Kept separate so it is never reported to a user as a connection problem.
 */
export class MalformedResponseError extends Error {
  readonly cause: unknown

  constructor(cause: unknown) {
    super('The server answered with content this screen could not read.')
    this.name = 'MalformedResponseError'
    this.cause = cause
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const errorData = await response.json().catch(() => ({
    detail: response.statusText,
  }))
  return new ApiError(
    response.status,
    formatApiErrorDetail(errorData.detail),
    errorData.detail
  )
}

/**
 * A robust API client that handles authentication and base path resolution.
 * @param endpoint The API endpoint to call, e.g., '/api/test' or '/api/admin/dashboard'.
 *                 The endpoint should include the '/api' prefix.
 * @param options Standard fetch options (method, body, etc.).
 */
async function apiClientFetch<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  // `getSession` already swallows its own failures and returns null, but a
  // throw here would otherwise be indistinguishable from a transport failure.
  const session = await getSession().catch(() => null)

  const headers = new Headers(options.headers || {})

  if (session?.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`)
  }

  // Construct the full URL: http://localhost:8001/app1/api/test
  const fullUrl = `${API_URL}${BASE_PATH}${endpoint}`

  let response: Response
  try {
    response = await fetch(fullUrl, { ...options, headers })
  } catch (cause) {
    // Only a genuine transport failure lands here. Everything else below is a
    // real answer from the server and must not be reported as one.
    throw new NetworkError(cause)
  }

  // If the backend returns a 401, log it but don't force redirect in dev mode
  if (response.status === 401) {
    console.warn('[API] 401 Unauthorized — check backend AUTH_BYPASS setting')
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  // Handle responses with no content
  if (response.status === 204) {
    return null as T
  }

  try {
    return (await response.json()) as T
  } catch (cause) {
    throw new MalformedResponseError(cause)
  }
}

/**
 * Open a streaming response (Server-Sent Events) with the same authentication
 * and base-path handling as the rest of the client.
 *
 * The browser `EventSource` API cannot send an `Authorization` header or a
 * `Last-Event-ID` header on the initial request, so progress streams are read
 * from the response body instead. The caller owns the reader and should pass an
 * `AbortSignal` to close it.
 */
export async function apiClientStream(
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const session = await getSession().catch(() => null)

  const headers = new Headers(options.headers || {})
  if (session?.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`)
  }
  headers.set('Accept', 'text/event-stream')

  let response: Response
  try {
    response = await fetch(`${API_URL}${BASE_PATH}${endpoint}`, {
      ...options,
      method: 'GET',
      cache: 'no-store',
      headers,
    })
  } catch (cause) {
    throw new NetworkError(cause)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  return response
}

/**
 * API client with convenience methods for common HTTP operations.
 */
export const apiClient = {
  /**
   * Open an authenticated Server-Sent Events stream.
   */
  stream: apiClientStream,

  /**
   * Perform a GET request.
   */
  get: <T = unknown>(endpoint: string, options?: RequestInit): Promise<T> => {
    return apiClientFetch<T>(endpoint, { ...options, method: 'GET' })
  },

  /**
   * Perform a POST request.
   */
  post: <T = unknown>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<T> => {
    return apiClientFetch<T>(endpoint, {
      ...options,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    })
  },

  /**
   * Perform a PUT request.
   */
  put: <T = unknown>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<T> => {
    return apiClientFetch<T>(endpoint, {
      ...options,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    })
  },

  /**
   * Perform a PATCH request.
   */
  patch: <T = unknown>(
    endpoint: string,
    data?: unknown,
    options?: RequestInit
  ): Promise<T> => {
    return apiClientFetch<T>(endpoint, {
      ...options,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    })
  },

  /**
   * Perform a DELETE request.
   */
  delete: <T = unknown>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> => {
    return apiClientFetch<T>(endpoint, { ...options, method: 'DELETE' })
  },
}

// Default export for backward compatibility
export default apiClientFetch
