const Hapi = require('hapi');
const mysql = require('mysql2/promise');
const fs = require('fs');
const util = require('util');
const Vision = require('vision');
const Twig = require('twig');
const setTimeoutPromise = util.promisify(setTimeout);

// Create a server with a host and port
const server = new Hapi.Server();
server.connection({
    host: 'localhost',
    port: 8004
});

// Static assets.
server.route({
    method: 'GET',
    path: '/application.css',
    handler: (request, h) => {
        return h.file('assets/application.css');
    }
});
server.route({
    method: 'GET',
    path: '/application.js',
    handler: (request, h) => {
        return h.file('assets/application.js');
    }
});

server.route({
    method: 'GET',
    path: '/',
    handler: (request, h) => {
        return h.view('index');
    }
});

server.route({
    method: 'GET',
    path: '/explain/{sql}',
    handler: (request, h) => {
        return explain(request.params.sql).then(results => {
            return h.view('index', {sql: request.params.sql, results});
        });
    }
});

server.route({
    method: 'GET',
    path: '/explain',
    handler: (request, h) => {
        if (request.query.sql) {
            return explain(request.query.sql).then(results => {
                return h.view('index', {sql: request.query.sql, results});
            });
        } else {
            return 'No query provided';
        }
    }
});

const provision = async () => {
    await server.register(Vision);
    await server.register(require('inert'));

    server.views({
        engines: {
            twig: {
                compile: (src, options) => {
                    const template = Twig.twig({ id: options.filename, data: src });

                    return context => {
                        return template.render(context);
                    };
                }
            }
        },
        relativeTo: __dirname,
        path: 'templates'
    });

    await server.start();
    console.log('Server running at:', server.info.uri);
};

function explain(sql) {
    const env = JSON.parse(fs.readFileSync('env.json', 'utf8'));

    const pool = mysql.createPool(Object.assign({
        database: 'enwiki_p'
    }, env));

    return Promise.all([
        pool.getConnection(),
        pool.getConnection(),
    ]).then(([queryConnection, explainConnection]) => {
        queryConnection.query(`SET max_statement_time = 1`).then(() => {
            sql = sql.replace(/\sFROM\s/i, ', SLEEP(1) FROM ');
            queryConnection.query(sql).then(() => {
                console.log('SLEEP SUCCESS');
            }).catch((err) => {
                // Queried should error from being killed.
            });
        });

        return setTimeoutPromise(500).then(() => {
            const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                pool.end();
                return result[0];
            }).catch(err => {
                pool.end();
                console.log('SHOW EXPLAIN failed: ', err);
            });

            return explainPromise;
        });
    });
}

provision();
