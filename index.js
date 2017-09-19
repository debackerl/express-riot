'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var express = require('express');
var riot = require('riot');
var redux = require('redux');
var chokidar = require('chokidar');
var EventEmitter = require('events');
var Module = require('module');
var vm = require('vm');

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

function loadTagFile(filename, callback) {
  fs.readFile(filename, 'utf8', (err, src) => {
    var tagName;

    if(!err) {
        try {
        var js = riot.compile(src, options.riot)

        var mod = new Module(filename);
        
        var context = {
          module: mod,
          __filename: filename,
          __dirname: path.dirname(filename),
          console: console,
          require: function (path) {
            //return mod.require(path);
            return require(path);
          }
        };
        
        tagName = vm.runInNewContext(`var riot = require('riot'); ${js}`, context);
      } catch(ex) {
        err = ex;
      }
    }

    if(callback) callback(err, tagName);
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
express.response.tag = function(tagName, actions, options) {
  // create the store
  const store = redux.createStore(this.app.get('reducer'), this.app.get('redux enhancer'));
  const root = path.resolve(this.app.get('static directory'));

  options = options || {};

  let prefix = this.app.get('prefix') || '';
  if(prefix.endsWith('/')) prefix = prefix.substr(0, prefix.length - 1);

  let actionsPromise = Promise.resolve();

  // if any, dispatch all actions to the store
  if(actions) {
    if(!Array.isArray(actions))
      actions = [actions];

    for(let action of actions)
      actionsPromise = actionsPromise.then(() => store.dispatch(action));
  }

  const stylesheets = this.locals.stylesheets || this.app.get('stylesheets');
  const scripts = this.locals.scripts || this.app.get('scripts');
  let hashes = {};
  let promises = [actionsPromise];

  // get hash of all stylesheets and scripts to be included
  for(let filePath of stylesheets.concat(scripts)) {
    let promise = getFileHash(path.join(root, filePath))
      .then(res => hashes[filePath] = res);
    promises.push(promise);
  }

  function prefixPath(filePath) {
    return filePath.startsWith('/') ? prefix + filePath : filePath;
  }

  // wait for completion of all actions before continuing
  Promise
  .all(promises)
  .then(() => {
    try {
      const state = store.getState();

      let tag = tagsByName[tagName];
      if(!tag) throw new Error(`Unknown tag ${tagName}`);

      // the store should already be ready because render() won't wait for asynchronous operations
      let html = riot.render(tagName, {isclient: false, store: store});

      let header = '';
      if(options.header)
        header = typeof(options.header) === 'function' ? options.header(state) : options.header;

      let httpCode = 200;
      if(options.httpCode)
        httpCode = typeof(options.httpCode) === 'function' ? options.httpCode(state) : options.httpCode;

      let rendered = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escape(state.title)}</title>
    ${this.locals.htmlHeader || this.app.get('html header')}
    ${header}
    ${String.prototype.concat.apply('', stylesheets.map(stylesheetPath => `<link rel="stylesheet" href="${prefixPath(stylesheetPath)}?h=${hashes[stylesheetPath]}">`))}
  </head>
  <body>
    ${html}
    <script>
      window.state = ${JSON.stringify(state)};
      window.tagName = ${JSON.stringify(tagName)};
    </script>
    ${String.prototype.concat.apply('', scripts.map(scriptPath => `<script src="${prefixPath(scriptPath)}?h=${hashes[scriptPath]}"></script>`))}
  </body>
</html>`;

      // window.tag = (function(riot) { return ${tag.src} })(require('riot'));

      this.status(httpCode);
      this.send(rendered);
    } catch(reason) {
      console.log(`${reason.stack}`);

      this.status(500);
      this.send(`Error while rendering: ${reason}`);
    }
  })
  .catch(reason => {
    this.status(500);
    this.send(`Error while dispatching actions: ${reason}`);
  });
};

exports.hotLoad = function(pathOrGlob) {
  var emitter = new EventEmitter();
  
  chokidar.watch(pathOrGlob).on('all', (event, path) => {
    if(event == 'add' || event == 'change') loadTagFile(path, (err, tagName) => {
      if(err) emitter.emit('error', err, path);
      else emitter.emit('loaded', tagName, path);
    });
  });

  return emitter;
};

exports.options = options;
