/* dependências */
var winston = require('winston'),
    prompt = require('prompt'),
    exec = require('child_process').exec,
    bitbucket = require('bitbucket-api'),
    moment = require('moment-timezone');

var filtersConfig = {};
var appStart = null;

/* helper para interpolação de strings */
var render = function (frmt, data) {
    return frmt.replace(/{([^{}]*)}/g,
        function (a, b) {
            var r = data[b] || '(null)';
            return typeof r === 'string' || typeof r === 'number' ? r : a;
        }
    );
};

/* configura os loggers */
var logFile = render('log_{date}.log', { date: moment().format('YYYY-MM-DD_HH-mm-ss') });
var outFile = render('out_{date}.log', { date: moment().format('YYYY-MM-DD_HH-mm-ss') });

var rawFormatter = function (args) {
    return args.message;
}

/* inicializa os loggers */
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({ colorize: true })
    ]
});

var _output = new (winston.Logger)({
    levels: {
        headers: 0,
        commits: 1,
        info: 2
    },
    transports: [
        new (winston.transports.File)({ level: 'commits', filename: outFile, json: false, formatter: rawFormatter })
    ]
});

var output = {
    header: function (s) {
        _output.log('headers', s);
        logger.info(s);
    },
    commit: function (s) {
        _output.log('commits', s);
        logger.info(s);
    },
    info: function (s) {
        _output.log('info', s);
        logger.info(s);
    }
};

/* consulta o nome de usuário nas configurações do git */
var getUsername = function (callback) {
    exec('git config --global user.email', function(error, stdout, stderr) {
        if (!error && stdout) {
            var username = stdout;

            if (username.indexOf('\n')) {
                username = username.split('\n')[0];
            }

            if (callback) {
                callback(username);
            }
        }
    });
}

/* pergunta ao usuário o nome de usuário e senha */
var getCredentials = function (callback) {
    getUsername(function (username) {
        var input = [
            {
                name: 'username', 
                default: username,
                warning: 'Digite seu email do Bitbucket!'
            },
            {
                name: 'password',
                hidden: true,
                default: process.env.BITBUCKET_PASSWORD,
                warning: 'Digite sua senha do Bitbucket!'
            },
            {
                name: 'dataInicial',
                default: moment().subtract(1, 'months').format('DD/MM/YYYY'),
                warning: 'Digite a data inicial!'
            },
            {
                name: 'dataFinal',
                default: moment().format('DD/MM/YYYY'),
                warning: 'Digite a data final!'
            },
            {
                name: 'prefixo',
                default: process.env.COUNTBUCKET_PREFIXO
            },
            {
                name: 'exibirVazios',
                default: 'false'
            },
            {
                name: 'cortarStrings',
                default: 0
            },
            {
                name: 'logGeral',
                default: 'false'
            }
        ];
        
        prompt.start();
        prompt.get(input, function (err, result) {
            if (err) {
                logger.error('ERRO: você deve digitar seu nome de usuário e senha do Bitbucket!');
                return;
            }
        
            if (callback) {
                callback({
                    username: result.username,
                    password: result.password
                }, {
                    dataInicial: result.dataInicial,
                    dataFinal: result.dataFinal,
                    prefixo: result.prefixo,
                    exibirVazios: result.exibirVazios,
                    cortarStrings: result.cortarStrings,
                    logGeral: result.logGeral
                });
            }
        });
    });
}

/* valida o prefixo de um repositório */
var validarPrefixo = function (slug) {
    if (!this.filtersConfig.prefixo || this.filtersConfig.prefixo.length === 0) {
        return true;
    }
    
    var test = slug.substr(0, this.filtersConfig.prefixo.length);
    if (test.toLowerCase().localeCompare(this.filtersConfig.prefixo.toLowerCase()) == 0) {
        return true;
    }
    
    return false;
}

/* filtra os repositórios com atualização no período desejado */
function filterRepos(obj) {
    var lastUpdated = moment(obj.utc_last_updated);
    
    if (!lastUpdated.isAfter(this.filtersConfig.dataInicial)) {
        return false;
    }
    
    if (!validarPrefixo(obj.name)) {
        return false;
    }
    
    return true;
}

/* consulta os commits de um repositório */
var fetchCommits = function (callback, repo, commits, hash) {
    var changes = repo.changesets();
    var needMoreCommits = false;
    
    if (!commits) {
        commits = [];
    }
    
    if (!hash) {
        hash = 'HEAD';
    }
    
    logger.debug('FROM ' + hash.substring(0, 12));
    changes.get(15, hash, function (err, result) {
        if (err) {
            /* parse error pode acontecer caso a resposta JSON do Bitbucket venha com problemas, neste caso, vamos tentar novamente */
            if (err.message.toLowerCase().indexOf('parse error') != -1) {
                logger.error(render('Parse error at {owner}/{slug}, trying again...', repo));
                setTimeout(function() {
                    fetchCommits(callback, repo, commits, hash);
                }, 3000);
                return;
            }
            
            /* outros erros não tratados */
            callback({
                owner: repo.owner,
                slug: repo.slug,
                commits: commits,
                error: err
            });
            logger.error(render('Error at {owner}/slug}!', repo));
            throw err;
            return;
        }
        
        if (result.changesets) {
            for (var i = result.changesets.length - 1; i >= 0; i--) {
                var item = result.changesets[i];
                
                var cur = moment(item.utctimestamp).tz('UTC');
                logger.debug('node: ' + item.node + ', cur = ' + cur.format() + ', inicial = ' + this.filtersConfig.dataInicial.format() + ', final = ' + this.filtersConfig.dataFinal.format());
                
                /* começou a paginação por este commit, parece que é o fim da linha. */
                if (item.raw_node == hash) {
                    logger.debug('no D - ' + item.raw_node + ' x ' + hash);
                    needMoreCommits = false;
                /* verifica se o commit atual está entre o período solicitado. */
                } else if (cur.isBetween(this.filtersConfig.dataInicial, this.filtersConfig.dataFinal)) {
                    logger.debug('yes A');
                    needMoreCommits = true;
                    
                    var message = item.message.replace(/\n?\r?/g, '');
                    if (this.filtersConfig.cortarStrings != 0) {
                        message = message.substr(0, this.filtersConfig.cortarStrings);
                    }
                    
                    commits.push({
                        repo: repo.name,
                        branch: item.branch,
                        node: item.node,
                        raw_node: item.raw_node,
                        author: item.author,
                        raw_author: item.raw_author,
                        utctimestamp: item.utctimestamp,
                        shortdate: moment(item.utctimestamp).tz('UTC').format('DD/MM/YYYY'),
                        message: message
                    });
                /* verifica se o commit atual está em um período superior a data inicial, mesmo não estando dentro da data final.
                 * isto indica que nas próximas páginas podemos encontrar resultados dentro do período. */
                } else if (cur.isAfter(this.filtersConfig.dataInicial)) {
                    logger.debug('yes B');
                    needMoreCommits = true;
                /* não está mais dentro do período solicitado. */
                } else {
                    logger.debug('no C');
                    needMoreCommits = false;
                }
            }
        }
        
        var next = result.changesets[0].raw_node;
        
        if (!next) {
            logger.info(render("Need more commits but it's EOF for {owner}/{slug}!", repo));
            needMoreCommits = false;
        }
        
        if (needMoreCommits) {
            fetchCommits(callback, repo, commits, next);
        } else {
            callback({
                owner: repo.owner,
                slug: repo.slug,
                commits: commits
            });
        }
    });
}

/* fluxo do programa */
var main = function() {
    getCredentials(function (credentials, config) {
        var client = bitbucket.createClient(credentials);
        var user = client.user();
        var repositories = user.repositories();
        this.filtersConfig = {
            dataInicial: moment(config.dataInicial, 'DD/MM/YYYY HH:mm:ss'),
            dataFinal: moment(config.dataFinal, 'DD/MM/YYYY HH:mm:ss'),
            prefixo: config.prefixo,
            exibirVazios: config.exibirVazios,
            cortarStrings: config.cortarStrings,
            logGeral: config.logGeral
        };
        
        if (this.filtersConfig.logGeral.toLowerCase() === 'true') {
            logger.add(winston.transports.File, { filename: logFile, json: false, formatter: rawFormatter });
        }
        
        output.info('Executando script de geração de baseline...');
        output.info('Configuração do script:');
        output.info(render(' * usuário: {username}', credentials));
        output.info(render(' * dataInicial: {data}', { data: this.filtersConfig.dataInicial.format('DD/MM/YYYY HH:mm:ss') } ));
        output.info(render(' * dataFinal: {data}', { data: this.filtersConfig.dataFinal.format('DD/MM/YYYY HH:mm:ss') } ));
        output.info(render(' * prefixo: {prefixo}', this.filtersConfig));
        output.info(render(' * exibirVazios: {exibirVazios}', this.filtersConfig));
        output.info(render(' * cortarStrings: {cortarStrings}', this.filtersConfig));
        output.info(render(' * logGeral: {logGeral}', this.filtersConfig));
        output.info(' ');
        
        repositories.getAll(function (err, data) {
			appStart = moment().tz('UTC');
            if (err) {
                logger.error(err);
                logger.warning('Please check your username, password and internet connection.');
                return;
            }
            
            if (data) {
                logger.info(render('Total de {qtde} repositórios encontrados.', { qtde: data.length }));
                var filtered = data.filter(filterRepos);
                logger.info(render('Filtrando {qtde} repositórios...', { qtde: filtered.length }));
                logger.info(' ');
                
                for (var i = 0; i < filtered.length; i++) {
                    var cur = filtered[i];
                    
                    logger.info('Consultando repositório ' + cur.name + '...');
                    client.getRepository({
                        owner: cur.owner,
                        slug: cur.name.toLowerCase()
                    }, function (err, repo) {
                        fetchCommits(function (data) {
                            if (data.commits.length !== 0 || this.filtersConfig.exibirVazios.toLowerCase() === 'true') {
                                logger.info(' ');
                                output.header('=== Repo: ' + data.owner + '/' + data.slug + ', Commits: ' + data.commits.length + ' ===');

                                if (data.error) {
                                    logger.error('  ERRO: ' + data.error);
                                }

                                for (var j = 0; j < data.commits.length; j++) {
                                    var item = data.commits[j];
                                    var model = {
                                        owner: repo.owner,
                                        repo: repo.name,
                                        branch: item.branch,
                                        node: item.node,
                                        raw_node: item.raw_node,
                                        author: item.author,
                                        raw_author: item.raw_author,
                                        utctimestamp: item.utctimestamp,
                                        shortdate: item.shortdate,
                                        message: item.message
                                    };
                                    output.commit(render('{owner}|{repo}|{branch}|{raw_node}|{shortdate}|{raw_author}|{message}|', model));
                                }
                                logger.info(' ');
                            }
                        }, repo);
                    });
                }
            }
        });
    });
}

/* prepara os handlers de saída do programa */
process.on('exit', function () {
    var appFinish = moment().tz('UTC');
    var diff = appFinish.diff(appStart, 'ms');
    logger.info(render('Programa finalizado em {tempo}s.', { tempo: (diff / 1000) }));
});

process.on('SIGNINT', function () {
    logger.info('[CTRL + C]');
    logger.info('Programa cancelado!');
    process.exit(2);
});

process.on('uncaughtException', function (err) {
    logger.error('Exceção não tratada:');
    logger.error(err.stack);
    process.exit(99);
});

/* executa o programa */
main();