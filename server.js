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
            const tips = getTips(request.query.sql, results);

            return h.view('index', {
                sql: request.query.sql,
                tips,
                use,
                results
            });
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
})

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

function explain(sql, database) {
    const pool = mysql.createPool({
        database: 'enwiki_p',
        host: env.db_host,
        port: env.db_port,
        user: env.db_user,
        password: env.db_password
    });

    return Promise.all([
        pool.getConnection(),
        pool.getConnection(),
    ]).then(([queryConnection, explainConnection]) => {
        return queryConnection.query(`USE ${database}`).then(() => {
            return queryConnection.query(`SET max_statement_time = 1`).then(() => {
                sql = sql.replace(/\sSELECT \s/gi, 'SELECT SLEEP(1), ');
                const query = queryConnection.query(sql).then(() => {
                    console.log('SLEEP SUCCESS');
                }).catch(err => {
                    pool.end();
                    if (err.errno !== 1969) {
                        console.log(err);
                        return {error: 'Query error: ' + err.message};
                    }
                });

                const explain = new Promise(resolve => setTimeout(() => {
                    const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                        pool.end();
                        return result[0];
                    }).catch(err => {
                        pool.end();
                        return {error: 'SHOW EXPLAIN failed: ' + err.message};
                    });

                    return resolve(explainPromise);
                }, 500));

                return Promise.all([query, explain]);
            });
        }).catch(err => {
            pool.end();
            return [{error: 'USE error: ' + err.message}, null];
        });
    }).catch(err => {
        pool.end();
        return [{error: 'Fatal error: ' + err.message}, null];
    });
}

function getTips(sql, explain) {
    if (!explain || explain.error) {
        // Query errored out or query plan unavailable.
        return {};
    }

    let tips = {};

    const pushTip = (index, comment) => {
        tips[index] = tips[index] || [];
        if (comment && !tips[index].includes(comment)) {
            tips[index].push(comment);
        }
    };

    // Tip to use userindexes:
    const userindexMatches = {
        'revision': 'rev_user',
        'archive': 'ar_user',
        'logging': 'log_user',
        'filearchive': 'fa_user',
        'ipblocks': 'ipb_user',
        'oldimage': 'oi_user',
        'recentchanges': 'rc_user',
    };

    Object.keys(userindexMatches).forEach(table => {
        if (new RegExp(`\\b${table}\\b[^]*\\b${userindexMatches[table]}`, 'i').test(sql)) {
            pushTip('*', `You appear to be querying the <code>${table}</code> table and filtering by user. ` +
                `It may be more efficient to use the <code>${table}_userindex</code> table.`);
        }
    });

    if (/\blogging\b[^]*\b(log_namespace|log_title|log_page)/i.test(sql)) {
        pushTip('*', 'You appear to be querying the <code>logging</code> table and filtering by namespace, title or page ID. ' +
            'It may be more efficient to use the <code>logging_logindex</code> table.');
    }

    // Query plan evalution.
    explain.forEach((plan, index) => {
        if (plan.Extra.includes('Using filesort')) {
            pushTip(index, `Query #${plan.id} is using ` +
                '<a target="_blank" href="https://dev.mysql.com/doc/refman/5.7/en/order-by-optimization.html#order-by-filesort">filesort</a>. ' +
                'This is usually an indication of an inefficient query. If you find your query is slow, try taking advantage ' +
                'of available indexes to avoid filesort.');
        }

        if (plan.Extra.includes('Using temporary')) {
            pushTip(index, `Query #${plan.id} is using a ` +
                '<a target="_blank" href="https://dev.mysql.com/doc/refman/8.0/en/internal-temporary-tables.html">temporary table</a>. ' +
                'This is usually an indication of an inefficient query. If you find your query is slow, try taking advantage ' +
                'of available indexes.');
        }

        if (plan.rows > 1000000) {
            pushTip(index, `Query #${plan.id} scans over a million rows. Your query could likely be improved.`)
        }
    });

    if (Object.keys(tips).length) {
        pushTip('*', 'When running slow-running queries in your application, consider prepending ' +
            '<code>SET STATEMENT max_statement_time = <i>N</i> FOR</code> to ' +
            '<a target="_blank" href="https://wikitech.wikimedia.org/wiki/Help:Toolforge/Database#Query_Limits">automatically kill</a> ' +
            'the query after <i>N</i> seconds.');
    }

    return tips;
}

provision();
