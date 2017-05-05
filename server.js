'use strict';

const app       = require('express')();
const server    = require('http').createServer(app);
const co        = require('co');
const request   = require('superagent');
const consul    = require('consul')({ host: '172.17.0.1', promisify: true });
const Docker    = require('dockerode');
const docker    = new Docker({socketPath: '/var/run/docker.sock'});
const winston   = require('winston');

let   state           = [];
let   generateFailure = false;
let   host            = null;
let   session         = null;

co(function*() {

    yield new Promise((resolve) => setTimeout(resolve, 5000));  // wait 5s

    host    = yield getHostIpAddress();
    session = yield getSession();

    console.log();
    console.log(`                Host address: ${host}`);
    console.log(`              Consul address: ${'172.17.0.1:8500'}`);
    console.log(`              Consul session: ${session}`);
    console.log(`    Health Check API address: ${'0.0.0.0:9999'}`);
    console.log(`                     version: ${process.env.VERSION||'-'}`);
    console.log();

    // OKAY

    app.get('/ok', function (req, res) {
        return res.status(state.generateFailure ? 500 : 200).end(state.generateFailure ? 'FAIL' : 'OK');
    });

    server.listen(9999, function () {
        winston.info(`Health Check API server started. Listening on port ${this.address().port}.`);
        winston.info(`Polling...`);
        setTimeout(poll, 500);
    });
});

//============================================================
//
//
//============================================================
function poll () { co(function*() {

    yield consul.session.renew(session);

    let containers = yield docker.listContainers();

    let actual = state.map(o=>o.Id);
    let needed = containers.map(o=>o.Id);

    let toCreate = containers.filter(o=>!actual.includes(o.Id));
    let toRemove = actual.filter(o=>!needed.includes(o));

    for(let container of toCreate) yield createService(container);
    for(let container of toRemove) yield removeService(container);

    setTimeout(poll, 5000);
});}

//============================================================
//
//
//============================================================
function* createService (container) {

    for(let port of container.Ports.filter(o=>o.PublicPort)) {

        let backend = container.Labels['SERVICE_' + port.PrivatePort];

        if(!backend) continue;

        winston.info('Service %s: adding upstream %s:%s (cid=%s)', backend, host, port.PublicPort, container.Id.substring(0,12));

        let key = 'traefik/backends/'+backend+'/servers/'+container.Id.substring(0,12)+'/url';

        yield consul.kv.del({ key: key });
        yield consul.kv.set({ key: key, value: 'http://'+host+':'+port.PublicPort, acquire: session });

        state.push({
            Id: container.Id,
            Name: backend,
            Host: host,
            Port: port.PublicPort,
            Key: key
        });
    }
}

//============================================================
//
//
//============================================================
function* removeService (container) {

    let index = state.findIndex(o=>o.Id==container);

    winston.info('Service %s: removing upstream %s:%s (cid=%s)', state[index].Name, state[index].Host, state[index].Port, container.substring(0,12));

    yield consul.kv.del(state[index].Key);

    state.splice(index, 1);
}

//============================================================
//
//
//============================================================
function* getHostIpAddress() {

    try {
        host = (yield request.get('http://169.254.169.254/latest/meta-data/local-ipv4')).text;
    } catch (error) {
        generateFailure = true;
        console.error('[FATAL] Failed to obtain host IP address from AWS EC2. Exiting...');
        process.exit(-1);
    }

    return host;
}

//============================================================
//
//
//============================================================
function* getSession() {

    try {
        session = (yield consul.session.create({ ttl: '30s', behavior: 'delete' })).ID;
    } catch (error) {
        generateFailure = true;
        console.error('[FATAL] Failed to obtain session with Consul. Exiting...');
        process.exit(-1);
    }

    return session;
}

//========================================================
//=================== ERROR HANDLING =====================
//========================================================

// app.use((err, req, res, next) => {
//     winston.error(`Unhandled exception occurred on HTTP request ${req.method} ${req.url}`);
//     winston.error(err);
//     res.status(500).send( { 'statusCode': 500 });
//     next(); // prevent errors (which may include stacktrace) from bubbling up
// });

process.on('unhandledRejection', (error/*, p*/) => {
    generateFailure = true;
    winston.error(`[FATAL] Unhandled rejection occurred`);
    winston.error(error);
    process.exit(-1);
});

process.on('SIGABRT', function() { generateFailure = true; winston.info('Received SIGABRT. Exiting...'); process.exit(); });
process.on('SIGINT',  function() { generateFailure = true; winston.info('Received SIGINT. Exiting...');  process.exit(); });
process.on('SIGTERM', function() { generateFailure = true; winston.info('Received SIGTERM. Exiting...'); process.exit(); });
