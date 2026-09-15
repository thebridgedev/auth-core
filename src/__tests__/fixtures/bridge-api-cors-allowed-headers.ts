// Checked-in copy of bridge-api's CORS allow-headers list (TBP-669).
//
// Source: bridge-api `src/lambda-http.shared.ts` → `CORS_ALLOWED_HEADERS`,
// as deployed on stage (526c3de) and prod. bridge-api answers every browser
// preflight with this list: the Lambda OPTIONS short-circuit
// (`lambda-http.bootstrap.ts`) and the API Gateway /auth OPTIONS mocks
// (`serverless.yml`).
//
// Keep it at what PROD answers, not what a pending bridge-api MR adds. A
// header is only safe for the SDK to send once every deployed bridge-api
// allows it, because customers run this SDK against prod. bridge-api MR for
// TBP-669 adds `x-bridge-realtime-ref`, but only so that the already
// published auth-core 0.7.0-beta.0 works. Do not add it here.
export const BRIDGE_API_CORS_ALLOWED_HEADERS = [
  'Origin',
  'X-Requested-With',
  'Content-Type',
  'Accept',
  'Authorization',
  'Cache-Control',
  'X-HTTP-Method-Override',
  'If-Match',
  'If-None-Match',
  'x-app-id',
  'x-api-key',
] as const;
