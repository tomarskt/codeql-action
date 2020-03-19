import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';

import * as configUtils from './config-utils';
import * as sharedEnv from './shared-environment';
import * as upload_lib from './upload-lib';
import * as util from './util';

interface SARIFFile {
  version: string | null;
  runs: any[];
}

function appendSarifRuns(combinedSarif: SARIFFile, newSarifRuns: SARIFFile) {
  // Check SARIF version
  if (combinedSarif.version === null) {
    combinedSarif.version = newSarifRuns.version;
  } else if (combinedSarif.version !== newSarifRuns.version) {
    throw "Different SARIF versions encountered: " + combinedSarif.version + " and " + newSarifRuns.version;
  }

  combinedSarif.runs.push(...newSarifRuns.runs);
}

async function autobuild(codeqlCmd: string, databaseFolder: string) {
  // Create db for scanned languages
  const scannedLanguages = process.env[sharedEnv.CODEQL_ACTION_LANGUAGES];
  if (scannedLanguages) {
    for (const language of scannedLanguages.split(',')) {
      core.startGroup('Autobuilding ' + language);

      if (language === "javascript" || language === "python" || language === "go") {
        core.info(language + " does not require any additional build steps. ");
      } else {

        // Get extractor location
        let extractorPath = '';
        await exec.exec(codeqlCmd, ['resolve', 'extractor', '--format=json', '--language=' + language], {
          silent: true,
          listeners: {
            stdout: (data) => { extractorPath += data.toString(); },
            stderr: (data) => { process.stderr.write(data); }
          }
        });

        // Set trace command
        const ext = process.platform === 'win32' ? '.cmd' : '.sh';
        const traceCommand = path.resolve(JSON.parse(extractorPath), 'tools', 'autobuild' + ext);

        // Run trace command
        await exec.exec(
          codeqlCmd,
          ['database', 'trace-command', path.join(databaseFolder, language), '--', traceCommand]);

        core.endGroup();
      }
    }
  }

  const languages = process.env[sharedEnv.CODEQL_ACTION_LANGUAGES] || '';
  for (const language of languages.split(',')) {
    core.startGroup('Finalizing ' + language);
    await exec.exec(codeqlCmd, ['database', 'finalize', path.join(databaseFolder, language)]);
    core.endGroup();
  }
}


async function run() {
  try {
    if (util.should_abort('finish')) {
      return;
    }
    const config = await configUtils.loadConfig();

    core.exportVariable(sharedEnv.ODASA_TRACER_CONFIGURATION, '');
    delete process.env[sharedEnv.ODASA_TRACER_CONFIGURATION];

    const codeqlCmd = process.env[sharedEnv.CODEQL_ACTION_CMD] || 'CODEQL_ACTION_CMD';
    const resultsFolder = process.env[sharedEnv.CODEQL_ACTION_RESULTS] || 'CODEQL_ACTION_RESULTS';
    const databaseFolder = path.join(resultsFolder, 'db');

    core.info('Starting autobuild');
    await autobuild(codeqlCmd, databaseFolder);

  } catch (error) {
    core.setFailed(error.message);
  }
}

void run();
