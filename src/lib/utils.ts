import { browser } from '$app/environment';

/**
 * Default branches to always include in the tracking list.
 * Includes unstable channels and the master branch.
 */
export const defaultBranches = [
	'staging-next',
	'master',
	'nixos-unstable-small',
	'nixpkgs-unstable',
	'nixos-unstable'
];

/**
 * Stores the GitHub Personal Access Token (PAT) in the browser's local storage.
 *
 * @param token - The GitHub API token to store.
 */
export function setToken(token: string) {
	if (browser) {
		localStorage.setItem('token', token);
	}
}

/**
 * Retrieves the stored GitHub Personal Access Token from local storage.
 *
 * @returns The stored token or null if not found or not in a browser environment.
 */
function getToken() {
	if (browser) {
		return localStorage.getItem('token');
	}
	return null;
}

/**
 * Synchronizes the authentication token from the server-side session to the client-side storage.
 *
 * This bridge is necessary because the application makes direct client-side calls to the GitHub API
 * to avoid bottling-necking the server and to leverage the user's own rate limits.
 *
 * It fetches the token from an internal API endpoint (`/api/auth/token`) and stores it if valid.
 */
export async function syncAuthToken() {
	if (!browser) return;
	try {
		const res = await fetch('/api/auth/token');
		if (res.ok) {
			const data = await res.json();
			if (data.token) {
				setToken(data.token);
			}
		}
	} catch (e) {
		console.error('Failed to sync auth token', e);
	}
}

/**
 * Checks if a GitHub API token is currently stored and available for use.
 *
 * @returns True if a token exists, false otherwise.
 */
export function hasToken(): boolean {
	return !!getToken();
}

/**
 * Constructs the headers for GitHub API requests, including the Authorization header if a token is present.
 *
 * @param extraHeaders - Additional headers to include in the request.
 * @returns A headers object ready for use in `fetch`.
 */
function header(extraHeaders: Record<string, string> = {}) {
	const token = getToken();
	const headers: Record<string, string> = { ...extraHeaders };
	if (token) {
		headers.Authorization = `token ${token}`;
	}
	return headers;
}

/**
 * Fetches the list of active NixOS/nixpkgs branches to track.
 *
 * It retrieves all matching refs from the `nixos/nixpkgs` repository, filters for stable release branches
 * (e.g., `nixos-23.11`, `nixpkgs-23.11`), sorts them by version, and takes the top 4 latest.
 * These are then merged with the `defaultBranches` list.
 *
 * @returns A promise that resolves to an array of unique branch names.
 *          Returns `defaultBranches` if the fetch fails.
 */
export async function getAllBranches(): Promise<string[]> {
	const headers = header();
	try {
		const response = await fetch(
			'https://api.github.com/repos/NixOS/nixpkgs/git/matching-refs/heads/nix',
			{ headers }
		);
		if (!response.ok) {
			console.error('Failed to fetch branches');
			return defaultBranches;
		}
		const data = await response.json();
		const nixosBranches = (data as { ref: string }[])
			.map((b) => b.ref.replace('refs/heads/', ''))
			.filter((name: string) => /^(nixos|nixpkgs)-\d+\.\d+(-small|-darwin)?$/.test(name))
			.sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }))
			.slice(0, 4); // Get top 4 latest stable branches (2 nixos + 2 nixpkgs approx)

		// Merge and deduplicate
		return Array.from(new Set([...defaultBranches, ...nixosBranches]));
	} catch (e) {
		console.error('Error fetching branches:', e);
		return defaultBranches;
	}
}

/**
 * Represents a GitHub user.
 */
export type User = {
	login: string;
	avatar_url: string;
	html_url: string;
};

/**
 * Represents a GitHub label.
 */
export type Label = {
	name: string;
	color: string;
	description: string;
};

/**
 * Represents the simplified details of a Pull Request used by the application.
 */
export type PR = {
	title: string;
	status: number;
	closed: boolean;
	merged: boolean;
	base: string;
	merge_commit_sha: string;
	body: string;
	body_html?: string;
	user: User;
	merged_by: User | null;
	labels: Label[];
	head_sha: string;
};

/**
 * Fetches detailed information for a specific Pull Request from the GitHub API.
 *
 * Normalizes the raw GitHub API response into a simplified `PR` object for frontend consumption.
 * Handles rate limiting and authentication errors by returning the status code in the PR object.
 *
 * @param pr - The Pull Request number or ID.
 * @returns A promise resolving to the PR details.
 */
export async function getPR(pr: string): Promise<PR> {
	const headers = header({
		Accept: 'application/vnd.github.html+json'
	});
	const response = await fetch(`https://api.github.com/repos/nixos/nixpkgs/pulls/${pr}`, {
		headers
	});

	const data = await response.json();

	return {
		title: data.title,
		status: response.status,
		closed: data.state === 'closed' && !data.merged_at,
		merged: data.merged_at !== null,
		base: data.base?.ref,
		merge_commit_sha: data.merge_commit_sha,
		body: data.body,
		body_html: data.body_html,
		user: data.user,
		merged_by: data.merged_by,
		labels: data.labels,
		head_sha: data.head?.sha
	};
}

/**
 * Fetches the list of users who have approved a specific Pull Request.
 *
 * It retrieves all reviews for the PR, filters for those with the 'APPROVED' state,
 * and deduplicates the users (since a user might approve multiple times).
 *
 * @param pr - The Pull Request number.
 * @returns A promise resolving to an array of unique `User` objects who approved the PR.
 */
export async function getReviews(pr: string): Promise<User[]> {
	const headers = header();
	const response = await fetch(`https://api.github.com/repos/nixos/nixpkgs/pulls/${pr}/reviews`, {
		headers
	});
	if (!response.ok) return [];
	const data = await response.json();

	// Filter for approved and deduplicate users
	const approvers = new Map<string, User>();
	(data as { state: string; user: User }[]).forEach((review) => {
		if (review.state === 'APPROVED') {
			approvers.set(review.user.login, review.user);
		}
	});

	return Array.from(approvers.values());
}

/**
 * Represents the status of a Continuous Integration (CI) check.
 */
export type CIStatus = {
	id: string;
	name: string;
	state: string; // success, failure, pending, etc.
	url: string;
	description: string;
};

/**
 * Aggregates detailed CI status information for a specific commit.
 *
 * Fetches data from two GitHub API endpoints:
 * 1. `statuses`: Legacy commit statuses (e.g., OfBorg).
 * 2. `check-runs`: GitHub Actions check runs.
 *
 * It deduplicates statuses by context/name and normalizes the state values.
 *
 * @param sha - The commit SHA to fetch status for.
 * @returns A promise resolving to a list of `CIStatus` objects.
 */
export async function getDetailedCIStatus(sha: string): Promise<CIStatus[]> {
	const headers = header();

	// Fetch Statuses (e.g. OfBorg)
	const statusesPromise = fetch(
		`https://api.github.com/repos/nixos/nixpkgs/commits/${sha}/statuses`,
		{ headers }
	).then((res) => (res.ok ? res.json() : []));

	// Fetch Check Runs (e.g. GitHub Actions)
	const checkRunsPromise = fetch(
		`https://api.github.com/repos/nixos/nixpkgs/commits/${sha}/check-runs`,
		{ headers }
	).then((res) => (res.ok ? res.json() : { check_runs: [] }));

	const [statuses, checkRunsData] = await Promise.all([statusesPromise, checkRunsPromise]);

	const ciStatuses: CIStatus[] = [];

	// Process Statuses
	// Statuses are returned latest first. We want unique contexts.
	const processedContexts = new Set<string>();
	for (const status of statuses) {
		if (!processedContexts.has(status.context)) {
			processedContexts.add(status.context);
			ciStatuses.push({
				id: status.id.toString(),
				name: status.context,
				state: status.state,
				url: status.target_url,
				description: status.description || ''
			});
		}
	}

	// Process Check Runs
	for (const run of checkRunsData.check_runs) {
		let state = 'pending';
		if (run.status === 'completed') {
			state = run.conclusion === 'success' ? 'success' : 'failure';
			if (run.conclusion === 'skipped' || run.conclusion === 'neutral') state = 'neutral';
		} else {
			state = 'pending';
		}

		ciStatuses.push({
			id: run.id.toString(),
			name: run.name,
			state: state,
			url: run.html_url,
			description: run.output?.title || ''
		});
	}

	return ciStatuses;
}

/**
 * Checks if a specific commit is contained within a branch's history.
 *
 * Uses the GitHub Compare API to check the relationship between the branch and the commit.
 * Returns `true` if the API reports the status as 'identical' (same commit) or 'behind'.
 *
 * Note: A status of 'behind' for `branch...commit` means the `commit` is an ancestor of the `branch` tip,
 * effectively meaning the commit is merged into the branch.
 *
 * @param branch - The name of the branch to check.
 * @param commit - The SHA of the commit (usually the merge commit of a PR).
 * @returns A promise resolving to `true` if the commit is in the branch, `false` otherwise.
 */
export async function isContain(branch: string, commit: string): Promise<boolean> {
	const headers = header();
	const url = `https://api.github.com/repos/nixos/nixpkgs/compare/${branch}...${commit}`;
	const response = await fetch(url, { headers });
	if (response.status === 404) {
		return false;
	}
	const data = await response.json();
	return data.status === 'identical' || data.status === 'behind';
}

/**
 * Represents a history item for a tracked PR.
 */
export type History = {
	pr: number;
	title: string;
	mergeCommit: string;
};

/**
 * Retrieves the user's PR tracking history from local storage.
 *
 * @returns An array of `History` items, or an empty array if none exist or not in a browser.
 */
export function getHistoryList(): History[] {
	if (!browser) return [];
	const history = localStorage.getItem('history');
	if (history) {
		return JSON.parse(history);
	}
	return [];
}

/**
 * Saves a PR to the user's tracking history in local storage.
 *
 * Checks for duplicates before adding to ensure each PR is only listed once.
 *
 * @param history - The history item to save.
 */
export function saveHistory(history: History) {
	if (!browser) return;
	const historyList = getHistoryList();
	// Check if it already exists to avoid duplicates
	if (!historyList.some((h) => h.pr === history.pr)) {
		historyList.push(history);
		localStorage.setItem('history', JSON.stringify(historyList));
	}
}

/**
 * Retrieves the title of a PR from the local history given its number.
 *
 * @param pr - The PR number.
 * @returns The title of the PR if found in history, otherwise an empty string.
 */
export function getHistoryTitle(pr: number): string {
	const history = getHistoryList();
	const item = history.find((item) => item.pr === pr);
	if (item) {
		return item.title;
	}
	return '';
}

/**
 * Removes a specific PR from the user's tracking history.
 *
 * @param pr - The PR number to remove.
 */
export function deleteHistory(pr: number) {
	if (!browser) return;
	const history = getHistoryList();
	const newHistory = history.filter((item) => item.pr !== pr);
	localStorage.setItem('history', JSON.stringify(newHistory));
}
