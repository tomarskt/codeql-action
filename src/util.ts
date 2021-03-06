import * as core from '@actions/core';
import * as http from '@actions/http-client';
import * as auth from '@actions/http-client/auth';
import * as octokit from '@octokit/rest';
import consoleLogLevel from 'console-log-level';
import * as path from 'path';

import * as sharedEnv from './shared-environment';

export function failWithUpgradeMessage() {
    const message = "This repository is deprecated. " +
        "Please update to using https://github.com/github/codeql-action instead. " +
        "See https://github.com/dsp-testing/codeql-action/blob/master/README.md for more information.";
    core.setFailed(message);
    throw new Error(message);
}

/**
 * Should the current action be aborted?
 *
 * This method should be called at the start of all CodeQL actions and they
 * should abort cleanly if this returns true without failing the action.
 * This method will call `core.setFailed` if necessary.
 */
export function should_abort(actionName: string, requireInitActionHasRun: boolean): boolean {

    // Check that required aspects of the environment are present
    const ref = process.env['GITHUB_REF'];
    if (ref === undefined) {
        core.setFailed('GITHUB_REF must be set.');
        return true;
    }

    // Should abort if called on a merge commit for a pull request.
    if (ref.startsWith('refs/pull/')) {
        core.warning('The CodeQL ' + actionName + ' action is intended for workflows triggered on `push` events, '
            + 'but the current workflow is running on a pull request. Aborting.');
        return true;
    }

    // If the init action is required, then check the it completed successfully.
    if (requireInitActionHasRun && process.env[sharedEnv.CODEQL_ACTION_INIT_COMPLETED] === undefined) {
        core.setFailed('The CodeQL ' + actionName + ' action cannot be used unless the CodeQL init action is run first. Aborting.');
        return true;
    }

    return false;
}

/**
 * Resolve the path to the workspace folder.
 */
export function workspaceFolder(): string {
    let workspaceFolder = process.env['RUNNER_WORKSPACE'];
    if (!workspaceFolder)
        workspaceFolder = path.resolve('..');

    return workspaceFolder;
}

/**
 * Get an environment parameter, but throw an error if it is not set.
 */
export function getRequiredEnvParam(paramName: string): string {
    const value = process.env[paramName];
    if (value === undefined) {
        throw new Error(paramName + ' environment variable must be set');
    }
    core.debug(paramName + '=' + value);
    return value;
}

/**
 * Gets the set of languages in the current repository
 */
async function getLanguagesInRepo(): Promise<string[]> {
    // Translate between GitHub's API names for languages and ours
    const codeqlLanguages = {
        'C': 'cpp',
        'C++': 'cpp',
        'C#': 'csharp',
        'Go': 'go',
        'Java': 'java',
        'JavaScript': 'javascript',
        'TypeScript': 'javascript',
        'Python': 'python',
    };
    let repo_nwo = process.env['GITHUB_REPOSITORY']?.split("/");
    if (repo_nwo) {
        let owner = repo_nwo[0];
        let repo = repo_nwo[1];

        core.debug(`GitHub repo ${owner} ${repo}`);
        let ok = new octokit.Octokit({
            auth: core.getInput('token'),
            userAgent: "CodeQL Action",
            log: consoleLogLevel({ level: "debug" })
        });
        const response = await ok.request("GET /repos/:owner/:repo/languages", ({
            owner,
            repo
        }));

        core.debug("Languages API response: " + JSON.stringify(response));

        // The GitHub API is going to return languages in order of popularity,
        // When we pick a language to autobuild we want to pick the most popular traced language
        // Since sets in javascript maintain insertion order, using a set here and then splatting it
        // into an array gives us an array of languages ordered by popularity
        let languages: Set<string> = new Set();
        for (let lang in response.data) {
            if (lang in codeqlLanguages) {
                languages.add(codeqlLanguages[lang]);
            }
        }
        return [...languages];
    } else {
        return [];
    }
}

/**
 * Get the languages to analyse.
 *
 * The result is obtained from the environment parameter CODEQL_ACTION_LANGUAGES
 * if that has been set, otherwise it is obtained from the action input parameter
 * 'languages' if that has been set, otherwise it is deduced as all languages in the
 * repo that can be analysed.
 *
 * If the languages are obtained from either of the second choices, the
 * CODEQL_ACTION_LANGUAGES environment variable will be exported with the
 * deduced list.
 */
export async function getLanguages(): Promise<string[]> {

    // Obtain from CODEQL_ACTION_LANGUAGES if set
    const langsVar = process.env[sharedEnv.CODEQL_ACTION_LANGUAGES];
    if (langsVar) {
        return langsVar.split(',')
            .map(x => x.trim())
            .filter(x => x.length > 0);
    }
    // Obtain from action input 'languages' if set
    let languages = core.getInput('languages', { required: false })
        .split(',')
        .map(x => x.trim())
        .filter(x => x.length > 0);
    core.info("Languages from configuration: " + JSON.stringify(languages));

    if (languages.length === 0) {
        // Obtain languages as all languages in the repo that can be analysed
        languages = await getLanguagesInRepo();
        core.info("Automatically detected languages: " + JSON.stringify(languages));
    }

    core.exportVariable(sharedEnv.CODEQL_ACTION_LANGUAGES, languages.join(','));

    return languages;
}

interface StatusReport {
    "workflow_run_id": number;
    "workflow_name": string;
    "job_name": string;
    "matrix_vars"?: string;
    "languages": string;
    "commit_oid": string;
    "action_name": string;
    "action_oid": string;
    "started_at": string;
    "completed_at"?: string;
    "status": string;
    "cause"?: string;
    "exception"?: string;
}

/**
 * Compose a StatusReport.
 *
 * @param actionName The name of the action, e.g. 'init', 'finish', 'upload-sarif'
 * @param status The status. Must be 'success', 'failure', or 'starting'
 * @param cause  Cause of failure (only supply if status is 'failure')
 * @param exception Exception (only supply if status is 'failure')
 */
async function createStatusReport(
    actionName: string,
    status: string,
    cause?: string,
    exception?: string):
    Promise<StatusReport> {

    const commitOid = process.env['GITHUB_SHA'] || '';
    const workflowRunIDStr = process.env['GITHUB_RUN_ID'];
    let workflowRunID = -1;
    if (workflowRunIDStr) {
        workflowRunID = parseInt(workflowRunIDStr, 10);
    }
    const workflowName = process.env['GITHUB_WORKFLOW'] || '';
    const jobName = process.env['GITHUB_JOB'] || '';
    const languages = (await getLanguages()).sort().join(',');
    const startedAt = process.env[sharedEnv.CODEQL_ACTION_STARTED_AT] || new Date().toISOString();
    core.exportVariable(sharedEnv.CODEQL_ACTION_STARTED_AT, startedAt);

    let statusReport: StatusReport = {
        workflow_run_id: workflowRunID,
        workflow_name: workflowName,
        job_name: jobName,
        languages: languages,
        commit_oid: commitOid,
        action_name: actionName,
        action_oid: "unknown", // TODO decide if it's possible to fill this in
        started_at: startedAt,
        status: status
    };

    // Add optional parameters
    if (cause) {
        statusReport.cause = cause;
    }
    if (exception) {
        statusReport.exception = exception;
    }
    if (status === 'success' || status === 'failure') {
        statusReport.completed_at = new Date().toISOString();
    }
    let matrix: string | undefined = core.getInput('matrix');
    if (matrix) {
        statusReport.matrix_vars = matrix;
    }

    return statusReport;
}

/**
 * Send a status report to the code_scanning/analysis/status endpoint.
 *
 * Returns the status code of the response to the status request, or
 * undefined if the given statusReport is undefined or no response was
 * received.
 */
async function sendStatusReport(statusReport: StatusReport): Promise<number | undefined> {
    const statusReportJSON = JSON.stringify(statusReport);

    core.debug('Sending status report: ' + statusReportJSON);

    const githubToken = core.getInput('token');
    const ph: auth.BearerCredentialHandler = new auth.BearerCredentialHandler(githubToken);
    const client = new http.HttpClient('Code Scanning : Status Report', [ph]);
    const url = 'https://api.github.com/repos/' + process.env['GITHUB_REPOSITORY']
        + '/code-scanning/analysis/status';
    const res: http.HttpClientResponse = await client.put(url, statusReportJSON);

    return res.message?.statusCode;
}

/**
 * Send a status report that an action is starting.
 *
 * If the action is `init` then this also records the start time in the environment,
 * and ensures that the analysed languages are also recorded in the envirenment.
 *
 * Returns true unless a problem occurred and the action should abort.
 */
export async function reportActionStarting(action: string): Promise<boolean> {
    const statusCode = await sendStatusReport(await createStatusReport(action, 'starting'));

    // If the status report request fails with a 403 or a 404, then this is a deliberate
    // message from the endpoint that the SARIF upload can be expected to fail too,
    // so the action should fail to avoid wasting actions minutes.
    //
    // Other failure responses (or lack thereof) could be transitory and should not
    // cause the action to fail.
    if (statusCode === 403) {
        core.setFailed('The repo on which this action is running is not opted-in to CodeQL code scanning.');
        return false;
    }
    if (statusCode === 404) {
        core.setFailed('Not authorized to used the CodeQL code scanning feature on this repo.');
        return false;
    }

    return true;
}

/**
 * Report that an action has failed.
 *
 * Note that the started_at date is always that of the `init` action, since
 * this is likely to give a more useful duration when inspecting events.
 */
export async function reportActionFailed(action: string, cause?: string, exception?: string) {
    await sendStatusReport(await createStatusReport(action, 'failure', cause, exception));
}

/**
 * Report that an action has succeeded.
 *
 * Note that the started_at date is always that of the `init` action, since
 * this is likely to give a more useful duration when inspecting events.
 */
export async function reportActionSucceeded(action: string) {
    await sendStatusReport(await createStatusReport(action, 'success'));
}
