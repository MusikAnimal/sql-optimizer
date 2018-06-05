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
server.route({
    method: 'GET',
    path: '/sql-optimizer/sql-formatter.min.js',
    handler: (request, h) => {
        return h.file('assets/vendor/sql-formatter.min.js');
    }
});

function extractUse(sql) {
    const matches = sql.match(/^use\s+(\w+(?:_p)?)\s*\n?;/i);

    if (null === matches) {
        return [sql, null];
    }

    sql = sql.replace(new RegExp(matches[0], 'i'), '');
    return [sql, matches[1]];
}

const getHandler = function (request, h) {
    if (request.query.sql) {
        let [sql, use] = extractUse(request.query.sql);
        use = use || request.query.use || 'enwiki_p';

        return explain(sql, use).then(([queryStatus, results]) => {
            let tips = {};

            if (queryStatus && queryStatus.error) {
                results = queryStatus;
            } else {
                [tips, results] = getTips(sql, results);
            }

            return h.view('index', {
                sql,
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

function validate(sql) {
    if (/SET.*?max_statement_time\s*=\s*/i.test(sql)) {
        return { error: 'Query error: max_statement_time cannot be set when using this tool.' };
    }

    return false;
}

function injectSleep(sql) {
    // They're SELECTing all rows. Putting SLEEP after the * works in this case.
    if (/^SELECT\s+\*/i.test(sql)) {
        console.log('yeah');
        return sql.replace(/\bFROM\b/i, ', SLEEP(1) FROM ');
    }

    // Otherwise try the normal injection of SLEEP at the front of the SELECT clause,
    // and for all SELECTs, which is more reliable.
    return sql.replace(/\bSELECT\s/gi, 'SELECT SLEEP(1), ');
}

function explain(sql, database) {
    let validation = validate(sql);
    if (validation) {
        return new Promise(resolve => resolve([validation, null]));
    }

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
                sql = injectSleep(sql);

                const query = queryConnection.query(sql).then(() => {
                    console.log('SLEEP SUCCESS');
                }).catch(err => {
                    pool.end();
                    if (err.errno !== 1969) {
                        console.log(err);
                        return { error: 'Query error: ' + err.message };
                    }
                });

                const explanation = new Promise(resolve => setTimeout(() => {
                    const explainPromise = explainConnection.query(`SHOW EXPLAIN FOR ${queryConnection.connection.threadId}`).then(result => {
                        pool.end();
                        return result[0];
                    }).catch(err => {
                        pool.end();
                        return { error: 'SHOW EXPLAIN failed: ' + err.message };
                    });

                    return resolve(explainPromise);
                }, 500));

                return Promise.all([query, explanation]);
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

function getTips(sql, explanation) {
    if (!explanation || explanation.error) {
        // Query errored out or query plan unavailable.
        return [{}, explanation];
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
        'recentchanges': 'rc_user'
    };

    Object.keys(userindexMatches).forEach(table => {
        if (new RegExp(`\\b${table}\\b[^]*\\b${userindexMatches[table]}`, 'i').test(sql)) {
            pushTip('0', `You appear to be querying the <code>${table}</code> table and filtering by user. ` + `It may be more efficient to use the <code>${table}_userindex</code> table.`);
        }
    });

    if (/\blogging\b[^]*\b(log_namespace|log_title|log_page)/i.test(sql)) {
        pushTip('0', 'You appear to be querying the <code>logging</code> table and filtering by namespace, title or page ID. ' + 'It may be more efficient to use the <code>logging_logindex</code> table.');
    }

    // Query plan evaluation.
    explanation.forEach((plan, index) => {
        if (plan.Extra.includes('Using filesort')) {
            pushTip(index, `Query plan ${plan.id}.${index + 1} is using ` + '<a target="_blank" href="https://dev.mysql.com/doc/refman/5.7/en/order-by-optimization.html#order-by-filesort">filesort</a>. ' + 'This is usually an indication of an inefficient query. If you find your query is slow, try taking advantage ' + 'of available indexes to avoid filesort.');
            plan.Extra = plan.Extra.replace(/(Using filesort)/, '<span class="text-danger">$1</span>');
        }

        if (plan.Extra.includes('Using temporary')) {
            pushTip(index, `Query plan ${plan.id}.${index + 1} is using a ` + '<a target="_blank" href="https://dev.mysql.com/doc/refman/8.0/en/internal-temporary-tables.html">temporary table</a>. ' + 'This is usually an indication of an inefficient query. If you find your query is slow, try taking advantage ' + 'of available indexes.');
            plan.Extra = plan.Extra.replace(/(Using temporary)/, '<span class="text-danger">$1</span>');
        }

        if (plan.rows > 1000000) {
            pushTip(index, `Query plan ${plan.id}.${index + 1} scans over a million rows. Your query could likely be improved, ` + `or broken out into multiple queries to improve performance.`);
        }
    });

    if (Object.keys(tips).length) {
        pushTip('*', 'When running potentially slow queries in your application, consider prepending ' + '<code>SET STATEMENT max_statement_time = <i>N</i> FOR</code> to ' + '<a target="_blank" href="https://wikitech.wikimedia.org/wiki/Help:Toolforge/Database#Query_Limits">automatically kill</a> ' + 'the query after <i>N</i> seconds.');
    }

    if (Object.keys(tips).length && /revision_userindex|logging_logindex/i) {
        pushTip('*', 'If you only need to query for recent revisions and log actions, using the <code>recentchanges</code> or ' + '<code>recentchanges_userindex</code> might be faster.');
    }

    return [tips, explanation];
}

provision();
