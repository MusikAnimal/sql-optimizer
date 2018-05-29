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

server.route({
    method: 'GET',
    path: '/sql-optimizer',
    handler: (request, h) => {
        return h.view('index');
    }
});

server.route({
    method: 'GET',
    path: '/sql-optimizer/explain/{sql}',
    handler: (request, h) => {
        return explain(request.params.sql).then(results => {
            return h.view('index', {sql: request.params.sql, results});
        });
    }
});

server.route({
    method: 'GET',
    path: '/sql-optimizer/explain',
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
    const pool = mysql.createPool(Object.assign({
        database: 'enwiki_p'
    }, {
        host: env.db_host,
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    }));

    return Promise.all([
        pool.getConnection(),
        pool.getConnection(),
    ]).then(function([queryConnection, explainConnection]) {
        queryConnection.query(`SET max_statement_time = 1`).then(() => {
            sql = sql.replace(/\sFROM\s/i, ', SLEEP(1) FROM ');
            queryConnection.query(sql).then(() => {
                console.log('SLEEP SUCCESS');
            }).catch(err => {
                // Queried should error from being killed. This return message is here as a safeguard,
                // but should never actually be shown to the user.
                return {error: 'Fatal error: ' + err.message};
            });
        });

        return new Promise(resolve => setTimeout(() => {
            const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                pool.end();
                return result[0];
            }).catch(err => {
                pool.end();
                return {error: 'SHOW EXPLAIN failed: ' + err.message};
            });

            return resolve(explainPromise);
        }, 500));
    }).catch(err => {
        pool.end();
        return {error: 'Fatal error: ' + err.message};
    });
}

provision();
