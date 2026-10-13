import { GITHUB_URL } from "@talorys/shared/constants";

/** This installation is deployed from Yishai's fork, not from the published npm package. */
export const REPO_URL = "https://github.com/theyishaik-lab/talorys";
/** The native Android app's source (apps/mobile in this repo; the old WebView repo was retired Oct 13, 2026). */
export const ANDROID_SOURCE_URL = `${REPO_URL}/tree/main/apps/mobile`;
export const DEPLOY_DOC_URL = `${REPO_URL}/blob/main/docs/system/DEPLOY.md`;
/** The project this fork is based on (rociiu/talorys). */
export const UPSTREAM_URL = GITHUB_URL;
