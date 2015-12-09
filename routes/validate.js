var express = require('express'),
    router = express.Router(),
    path = require('path'),
    azureTools = require('../modules/azure'),
    Guid = require('guid'),
    fs = require('fs'),
    conf = require('../modules/config');
    RSVP = require('rsvp'),
    githubHelper = require('../modules/github_helper'),
    DelayedResponse = require('http-delayed-response');

var debug = require('debug')('arm-validator:server');

function writeFileHelper (fs, fileName, parametersFileName, template, parameters) {
  var writeFile = RSVP.denodeify(fs.writeFile);
  return writeFile.call(fs, fileName, JSON.stringify(template, null, '\t'))
  .then(function () {
    return writeFile.call(fs, parametersFileName, JSON.stringify(parameters, null, '\t'));
  })
}

function replaceRawLinksForPR (template, prNumber) {
  var templateString = JSON.stringify(template);
  // we make the assumption all links target a source on master
  var replaceTarget = 'https://' + path.join('raw.githubusercontent.com/', conf.get('GITHUB_REPO'), '/master');
  debug('replaceTarget: ' + replaceTarget);
  return githubHelper.getPullRequestBaseLink(prNumber)
  .then(link => {
    // replace something like 'https://raw.githubusercontent.com/azure/azure-quickstart-templates/master'
    // with 'https://raw.githubusercontent.com/user/azure-quickstart-templates/sourcebranch'
    return JSON.parse(templateString.replace(new RegExp(replaceTarget, 'g'), link));
  });
}
router.post('/validate', function(req, res, next) {

  var fileName = Guid.raw(),
      parametersFileName = Guid.raw();
      

  writeFileHelper(fs, fileName, parametersFileName, req.body.template, req.body.parameters)
  .then(function () {
    debug('wrote: ');
    debug(JSON.stringify(req.body.template, null, '\t'));
    debug('file: ' + fileName);
    debug(azureTools.validateTemplate);
    return azureTools.validateTemplate(fileName, parametersFileName);
  })
  .then(function () {
    return res.send({result: 'Template Valid'});
  })
  .catch(function (err) {
    return res.status(400).send({error: err.toString()});
  })
  .finally(function () {
    fs.unlink(fileName);
    fs.unlink(parametersFileName);
  });
});

router.post('/deploy', function (req, res, next) {

  var fileName = Guid.raw(),
      rgName = conf.get('RESOURCE_GROUP_NAME_PREFIX') + Guid.raw(),
      parametersFileName = Guid.raw();

  var delayed = new DelayedResponse(req, res);
  // shortcut for res.setHeader('Content-Type', 'application/json') 
  delayed.json();
  // start activates long-polling - headers must be set before 
  for (var key in req.body.parameters.parameters) {
    // for unique parameters replace with a guid
    if (/##\#+/.test(req.body.parameters.parameters[key].value)) {
      req.body.parameters.parameters[key].value = 'citest' + Guid.raw().replace(/-/g,'').substring(0, 16);
    }
    // for ssh keys, use configured ssh public key
    if (req.body.parameters.parameters[key].value === conf.get('SSH_KEY_REPLACE_INDICATOR')) {
      req.body.parameters.parameters[key].value = conf.get('SSH_PUBLIC_KEY');
    }
    // for passwords use a random azure-compatible password
    if (req.body.parameters.parameters[key].value === conf.get('PASSWORD_REPLACE_INDICATOR')) {
      req.body.parameters.parameters[key].value = 'ciP@ss' + Guid.raw().replace(/-/g,'').substring(0, 16);
    }
  }

  var responseHandler = delayed.start();
  var promise = new RSVP.Promise((resolve, reject) => {
    resolve();
  });

  debug('pull request number: ' + req.body.pull_request)
  if (req.body.pull_request) {
    promise = promise
    .then(() => {
      return replaceRawLinksForPR(req.body.template, req.body.pull_request)
    })
    .then((modifiedTemplate) => {
      debug('modified template is:');
      debug(modifiedTemplate);
      req.body.template = modifiedTemplate;
    });
  }

  promise.then(() => {
    return writeFileHelper(fs, fileName, parametersFileName, req.body.template, req.body.parameters);
  })
  .then(function () {
    debug('deploying template: ');
    debug(JSON.stringify(req.body.template, null, '\t'));
    debug('with paremeters: ');
    debug(JSON.stringify(req.body.parameters, null, '\t'))
    return azureTools.testTemplate(fileName, parametersFileName, rgName);
  })
  .then(function () {
    debug('Deployment Successful');
    // stop sending long poll bytes
    delayed.stop();
    return res.end(JSON.stringify({result: 'Deployment Successful'}));
  })
  .catch(function (err) {
    debug(err);
    debug('Deployment not Sucessful');
    // stop sending long poll bytes
    delayed.stop();
    return res.end(JSON.stringify({error: err.toString(), 
        _rgName: rgName, 
        command: 'azure group deployment create --resource-group (your_group_name) --template-file azuredeploy.json --parameters-file azuredeploy.parameters.json',
        parameters: JSON.stringify(req.body.parameters),
        template: JSON.stringify(req.body.template)
      })
    );
  })
  .finally(function () {
    fs.unlink(fileName);
    fs.unlink(parametersFileName);

    azureTools.deleteGroup(rgName)
    .then(() => {
      debug('Sucessfully cleaned up resource group: ' + rgName);
    })
    .catch((err) => {
      console.error('failed to delete resource group: ' + rgName);
      console.error(err);
    });
  });
});

module.exports = router;
