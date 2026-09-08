#!/usr/bin/env node
/** Builds the ephemeral hosted bridge without installing a local service. */
'use strict'

const esbuild = require('esbuild')
const path = require('path')

esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'remote-forwarder.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(__dirname, '.remote-forwarder.js'),
  alias: {
    vscode: path.join(__dirname, 'vscode-shim.js'),
  },
  sourcemap: true,
  logLevel: 'warning',
})

