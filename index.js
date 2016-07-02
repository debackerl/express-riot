'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var express = require('express');
var riot = require('riot');
var redux = require('redux');

let tagsByName = {};
let hashByFile = {};

let options = {
  riot: {type: 'es6', parserOptions:{js:{resolveModuleSource:null}}}
};

function checksum(str, algorithm, encoding) {
  return crypto
    .createHash(algorithm || 'sha256')
    .update(str, 'utf8')
    .digest(encoding || 'hex')
}

function getFileHash(path) {
  return new Promise((resolve, reject) => {
    let h = hashByFile[path];
    
    if(h) resolve(h);
    else fs.readFile(path, function(err, data) {
      if(err) reject(err);
      else resolve(hashByFile[path] = checksum(data).substr(0, 32));
    });
  });
}

// custom source code file loader to use ES6 by default for tag files 
require.extensions['.tag'] = function(module, filename) {
  let src = riot.compile(require('fs').readFileSync(filename, 'utf8'), options.riot);
  module._compile(`var riot = require('riot'); module.exports = ${src}`, filename);
  let tagName = module.exports;

  if(tagName in tagsByName && tagsByName[tagName].filename != filename)
    throw new Error(`Duplicated tag ${tagName} found in files ${tagsByName[tagName].filename} and ${filename}`);
  
  tagsByName[tagName] = { src: src, filename: filename };
};

// add a new 'tag' method to 'response' objects of the express framework
express.response.tag = function(tagName, actions) {
  // create the store
  const store = redux.createStore(this.app.get('reducer'), this.app.get('redux enhancer'));
  const root = path.resolve(this.app.get('static directory'));

  let actionsPromise = Promise.resolve();

  // if any, dispatch all actions to the store
  if(actions) {
    if(!Array.isArray(actions))
      actions = [actions];

    for(let action of actions)
      actionsPromise = actionsPromise.then(() => store.dispatch(action));
  }

  const scripts = this.app.get('scripts');
  let hashes = {};
  let promises = [actionsPromise];

  // get hash of all scripts to be included
  for(let scriptPath of scripts) {
    let promise = getFileHash(path.join(root, scriptPath))
      .then(res => hashes[scriptPath] = res);
    promises.push(promise);
  }

  // wait for completion of all actions before continuing
  Promise
  .all(promises)
  .catch(reason => {
      this.status(500);
      this.send(`Error while dispatching actions: ${reason}`);
  }).then(() => {
      const state = store.getState();

      let tag = tagsByName[tagName];
      if(!tag) throw new Error(`Unknown tag ${tagName}`);

      // the store should already be ready because render() won't wait for asynchronous operations
      let html = riot.render(tagName, {isclient: false, store: store});

      let rendered = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escape(state.title)}</title>
    ${this.app.get('html header')}
  </head>
  <body>
    ${html}
    <script>
      window.state = ${JSON.stringify(state)};
      window.tagName = ${JSON.stringify(tagName)};
    </script>
    ${''.concat(...scripts.map(scriptPath => `<script src="${scriptPath}?h=${hashes[scriptPath]}"></script>`))}
  </body>
</html>`;

      // window.tag = (function(riot) { return ${tag.src} })(require('riot'));

      this.status(200);
      this.send(rendered);
    })
    .catch(reason => {
      console.log(`${reason.stack}`);

      this.status(500);
      this.send(`Error while rendering: ${reason}`);
    });
};

exports.options = options;
