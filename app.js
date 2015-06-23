// --------------------------------------------------------
// Para ver o log do programa em formato amigável, use:
// $ npm install -g bunyan
// $ node app.js
// $ cat log_xyz.log | bunyan -o short
// --------------------------------------------------------

/* dependências */
var bunyan = require('bunyan'),
    prompt = require('prompt'),
    exec = require('child_process').exec,
    bitbucket = require('bitbucket-api'),
    moment = require('moment-timezone');

var filtersConfig = {};

/* helper para interpolação de strings */
var render = function (frmt, data) {
    return frmt.replace(/{([^{}]*)}/g,
        function (a, b) {
            var r = data[b] || '(null)';
            return typeof r === 'string' || typeof r === 'number' ? r : a;
        }
    );
};

/* configura o logger */
var fn = render('log_{date}.log', { date: moment().format('YYYY-MM-DD_HH-mm-ss') });
var log = bunyan.createLogger({
    name: 'Baseline',
    streams: [
        {
            level: 'trace',
            stream: process.stdout,
        },
        {
            level: 'trace',
            path: fn
        }
    ]
});

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
                default: moment().tz('UTC').subtract(14, 'days').format('DD/MM/YYYY'),
                warning: 'Digite a data inicial!'
            },
            {
                name: 'dataFinal',
                default: moment().tz('UTC').format('DD/MM/YYYY'),
                warning: 'Digite a data final!'
            },
            {
                name: 'prefixo',
                default: ''
            },
            {
                name: 'exibirVazios',
                default: false
            },
            {
                name: 'cortarStrings',
                default: 50
            }
        ];
        
        prompt.start();
        prompt.get(input, function (err, result) {
            if (err) {
                log.trace('ERRO: você deve digitar seu nome de usuário e senha do Bitbucket!');
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
                    cortarStrings: result.cortarStrings
                });
            }
        });
    });
}

/* filtra os repositórios com atualização no período desejado */
function filterDateRange(obj) {
    var lastUpdated = moment(obj.utc_last_updated);
    return lastUpdated.isAfter(this.filtersConfig.dataInicial);
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
    
    //log.trace('FROM ' + hash.substring(0, 12));
    changes.get(15, hash, function (err, result) {
        if (err) {
            callback({
                owner: repo.owner,
                slug: repo.slug,
                commits: commits,
                error: err
            });
            return;
        }
        
        if (result.changesets) {
            for (var i = result.changesets.length - 1; i >= 0; i--) {
                var item = result.changesets[i];
                
                var cur = moment(item.utctimestamp).tz('UTC');
                //log.trace('node: ' + item.node + ', cur = ' + cur.format() + ', inicial = ' + this.filtersConfig.dataInicial.format() + ', final = ' + this.filtersConfig.dataFinal.format());
                
                if (cur.isBetween(this.filtersConfig.dataInicial, this.filtersConfig.dataFinal)) {
                    //log.trace('yes A');
                    needMoreCommits = true;
                    
                    var message = item.message.replace('\n', '');
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
                } else if (cur.isAfter(this.filtersConfig.dataInicial)) {
                    //log.trace('yes B');
                    needMoreCommits = true;
                } else {
                    //log.trace('no C');
                    needMoreCommits = false;
                }
            }
        }
        
        if (needMoreCommits) {
            fetchCommits(callback, repo, commits, result.changesets[0].raw_node);
        } else {
            callback({
                owner: repo.owner,
                slug: repo.slug,
                commits: commits
            });
        }
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

/* fluxo do programa */
var main = function() {
    getCredentials(function (credentials, config) {
        var client = bitbucket.createClient(credentials);
        var user = client.user();
        var repositories = user.repositories();
        this.filtersConfig = {
            dataInicial: moment(config.dataInicial, 'DD/MM/YYYY').tz('UTC'),
            dataFinal: moment(config.dataFinal, 'DD/MM/YYYY').tz('UTC'),
            prefixo: config.prefixo,
            exibirVazios: config.exibirVazios,
            cortarStrings: config.cortarStrings
        };
        
        log.trace('Executando script de geração de baseline...');
        log.trace(this.filtersConfig);
        
        repositories.getAll(function (err, data) {
            if (err) {
                log.trace(err);
                log.trace('Please check your username, password and internet connection.');
                return;
            }
            
            if (data) {
                var filtered = data.filter(filterDateRange);
                
                for (var i = 0; i < filtered.length; i++) {
                    var cur = filtered[i];
                    
                    if (validarPrefixo(cur.name)) {
                        client.getRepository({
                            owner: cur.owner,
                            slug: cur.name.toLowerCase()
                        }, function (err, repo) {
                            fetchCommits(function (data) {
                                if (data.commits.length !== 0 || this.filtersConfig.exibirVazios) {
                                    log.trace('=== Repo: ' + data.owner + '/' + data.slug + ', Commits: ' + data.commits.length + ' ===');
                                    
                                    if (data.error) {
                                        log.trace('  ERRO: ' + data.error);
                                    }
                                    
                                    for (var j = 0; j < data.commits.length; j++) {
                                        log.trace(render('  {branch}|{node}|{shortdate}|{author}|{message}|', data.commits[j]));
                                    }
                                    log.trace(' ');
                                }
                            }, repo);
                        });
                    }
                }
            }
        });
    });
}

/* executa o programa */
main();