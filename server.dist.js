'use strict';

function _asyncToGenerator(fn) { return function () { var gen = fn.apply(this, arguments); return new Promise(function (resolve, reject) { function step(key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { return Promise.resolve(value).then(function (value) { step("next", value); }, function (err) { step("throw", err); }); } } return step("next"); }); }; }

const Hapi = require('hapi');
const mysql = require('mysql2/promise');
const fs = require('fs');
const util = require('util');
const Vision = require('vision');
const Twig = require('twig');
const env = JSON.parse(fs.readFileSync('env.json', 'utf8'));

// Create a server with a host and port
const server = new Hapi.Server();
server.connection({
    host: env.server_host,
    port: env.server_host === 'localhost' ? env.server_port : process.env.PORT
});

// Static assets.
server.route({
    method: 'GET',
    path: '/sql-optimizer/application.css',
    handler: (request, h) => {
        return h.file('assets/application.css');
    }
});
server.route({
    method: 'GET',
    path: '/sql-optimizer/application.js',
    handler: (request, h) => {
        return h.file('assets/application.js');
    }
});

const getHandler = function (request, h) {
    if (request.query.sql) {
        const use = request.query.use || 'enwiki_p';
        return explain(request.query.sql, use).then(([queryStatus, results]) => {
            results = queryStatus && queryStatus.error ? queryStatus : results;
            return h.view('index', { sql: request.query.sql, use, results });
        });
    } else {
        return h.view('index');
    }
};

server.route({
    method: 'GET',
    path: '/sql-optimizer',
    handler: getHandler
});

server.route({
    method: 'GET',
    path: '/sql-optimizer/',
    handler: getHandler
});

const provision = (() => {
    var _ref = _asyncToGenerator(function* () {
        yield server.register(Vision);
        yield server.register(require('inert'));

        server.views({
            engines: {
                twig: {
                    compile: function (src, options) {
                        const template = Twig.twig({ id: options.filename, data: src });

                        return function (context) {
                            return template.render(context);
                        };
                    }
                }
            },
            relativeTo: __dirname,
            path: 'templates'
        });

        yield server.start();
        console.log('Server running at:', server.info.uri);
    });

    return function provision() {
        return _ref.apply(this, arguments);
    };
})();

function explain(sql, database) {
    const pool = mysql.createPool({
        database: 'enwiki_p',
        host: env.db_host,
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    });

    return Promise.all([pool.getConnection(), pool.getConnection()]).then(([queryConnection, explainConnection]) => {
        return queryConnection.query(`USE ${database}`).then(() => {
            return queryConnection.query(`SET max_statement_time = 1`).then(() => {
                sql = sql.replace(/\sFROM\s/i, ', SLEEP(1) FROM ');
                const query = queryConnection.query(sql).then(() => {
                    console.log('SLEEP SUCCESS');
                }).catch(err => {
                    pool.end();
                    if (err.errno !== 1969) {
                        return { error: 'Query error: ' + err.message };
                    }
                });

                const explain = new Promise(resolve => setTimeout(() => {
                    const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                        pool.end();
                        return result[0];
                    }).catch(err => {
                        pool.end();
                        return { error: 'SHOW EXPLAIN failed: ' + err.message };
                    });

                    return resolve(explainPromise);
                }, 500));

                return Promise.all([query, explain]);
            });
        }).catch(err => {
            pool.end();
            return [{ error: 'USE error: ' + err.message }, null];
        });
    }).catch(err => {
        pool.end();
        return [{ error: 'Fatal error: ' + err.message }, null];
    });
}

provision();
