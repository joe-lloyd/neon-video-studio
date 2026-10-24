/**
 * The Google Cloud OAuth client ("Desktop app" type) built into release builds. Source builds ship
 * it empty: the release workflow fills both values in from repository secrets before it bundles
 * the app (see .github/workflows/release.yml). Without it, sign in with your own client:
 * NEON_YOUTUBE_CLIENT_ID / NEON_YOUTUBE_CLIENT_SECRET or `neon-cli youtube client`.
 *
 * Google treats a desktop client's secret as non-confidential (it ships inside every install);
 * it is kept out of git only so a fork does not reuse this project's quota.
 */
export const BUILT_IN_YOUTUBE_CLIENT = { clientId: '', clientSecret: '' };
