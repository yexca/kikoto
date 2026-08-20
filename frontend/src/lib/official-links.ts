const dlsiteWebBaseURL = "https://www.dlsite.com";
const kikotoGitHubRepositoryURL = "https://github.com/yexca/kikoto";

export const DLSITE_ENDPOINTS = Object.freeze({
  webBaseURL: dlsiteWebBaseURL,
  workURL(site: string, primaryCode: string) {
    return `${dlsiteWebBaseURL}/${encodeURIComponent(site)}/work/=/product_id/${encodeURIComponent(primaryCode)}.html`;
  },
  makerURL(site: string, externalId: string) {
    return `${dlsiteWebBaseURL}/${encodeURIComponent(site)}/circle/profile/=/maker_id/${encodeURIComponent(externalId)}.html`;
  },
});

export const KIKOTO_GITHUB_ENDPOINTS = Object.freeze({
  repositoryURL: kikotoGitHubRepositoryURL,
  releasesURL: `${kikotoGitHubRepositoryURL}/releases`,
  licenseURL: `${kikotoGitHubRepositoryURL}/blob/main/LICENSE`,
});
