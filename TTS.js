var console = require('console');
var config  = require('./config');
var sys     = require('sys');
var nats    = require('nats').connect();
var exec    = require('child_process').exec;
var execSync = require('child_process').execSync;
var soap    = require('soap');
var crypto  = require('crypto');
var net     = require('net');
var fs      = require('fs');
var Buffer  = require('buffer').Buffer;

var voice_path = "./controls/humix-sense-speech/voice/";
var url = 'http://tts.itri.org.tw/TTSService/Soap_1_3.php?wsdl';
var connHumixSpeech = null;


function puts(error, stdout, stderr) {sys.puts(stdout)}

function convertText(text, hash, callback) {
    var args = {
        accountID: 'richchou',
        password: 'zaq12wsx',
        TTStext: text,
        TTSSpeaker: 'Bruce',
        volume: 50,
        speed: 0,
        outType: 'wav'
    };
    soap.createClient(url, function(err, client) {
        client.ConvertText(args, function(err, result) {
            if (err) {
                console.log('err: '+err);
                callback(err, null);
            }
            var id = result.Result.$value.split('&')[2];
            if (id) {
                console.log('get id: '+id);
                callback(null, id, hash);
            } else {
                var error = 'failed to convert text!';
                console.log(error);
                callback(error, null);
            }
        });
    });
}

function getConvertStatus(id, callback) {
    var args = {
        accountID: 'richchou',
        password: 'zaq12wsx',
        convertID: id
    };
    soap.createClient(url, function(err, client) {
        console.log("msg_id " + id);
        client.GetConvertStatus(args, function(err, result) {
            if (err) {
                console.log('err: '+err);
                callback(err, null);
            }
            var downloadUrl = result.Result.$value.split('&')[4];
            if (downloadUrl) {
                //console.log('get download url: '+downloadUrl);
                console.log(id + " " + downloadUrl);
                var wav_file = voice_path + "text/" + id + ".wav";
                execSync("wget "+ downloadUrl + " -O " + wav_file, null);
                callback(null, id);
            } else {
                var error = 'Still converting! result: '+JSON.stringify(result);
                console.log(error);
                callback(error, null);
            }
        });
    });
}

var retry = 0;
function download (id) {
    retry++;
    console.log(id+ " " +" download" );
    getConvertStatus(id, function(err, result) {
        if (err) 
        { 
            console.log('err: '+err); 
            if (retry < 10)
            {
               console.log("retry " + retry);
               setTimeout(download, 2000, id);
            }
        }
        else 
        {
           var wav_file = voice_path + "text/" + result + ".wav";
           console.log('Play wav file: ' + wav_file);
           sendAplay2HumixSpeech(connHumixSpeech, wav_file);
        }
    });
}


function sendAplay2HumixSpeech( conn, file ) {
    if ( !conn || !file ) {
        return;
    }
    var len = 4 + 1 + file.length; //uint32_t, uint8_t, string
    var msg = new Buffer(len);
    msg.writeUInt32LE(len - 4, 0);
    msg.writeUInt8(1, 4);// 1- aplay, 2 - xxxx
    msg.write(file, 5);
    conn.write(msg);
}

var msg = '';
var wavehash = new Object();
// subscribe events
nats.subscribe('humix.sense.speech.command', function(msg) {
    console.log('Received a message: ' + msg);
    var text = JSON.parse(msg).text || undefined,
        wav_file = '';

    if (!text) {
        return console.error('Missing property: msg.text');
    }

    var hash = crypto.createHash('md5').update(text).digest('hex');
    console.log ("hash value: " + hash);
    if (wavehash.hasOwnProperty(hash)) {
        var wav_file = voice_path + "text/" + wavehash[hash] + ".wav";
        console.log('Play hash wav file: ' +  wav_file);
        sendAplay2HumixSpeech(connHumixSpeech, wav_file);
    }
    else {
        console.log("hash not found");
        convertText(text, hash, function(err, id, hashvalue) {
            if (err) { console.log(err); }
            else {
                wavehash[hashvalue] = id;
                retry = 0;
                setTimeout(download, 1000, id);
            }
        });
    }
});


//create domain socket before fork humix-speech
try {
    fs.unlinkSync('/tmp/humix-speech-socket'); //remove domain socket if there is
} catch ( e ) {}
var server = net.createServer(function(conn) { //'connection' listener
    conn.on('end', function() {
        console.log('humix-speech disconnected');
    });
    console.error('humix-speech connected');
    connHumixSpeech = conn;
});

server.listen('/tmp/humix-speech-socket', function() { //'listening' listener
    console.log('ready for humix-speech to hook up');
});

//use child process to handle speech to text
var speechProc = exec(config.speechCmd + ' ' + config.args.join(' '), function (error) {
    console.error(error);
});

var commandRE = /---=(.*)=---/;
var prefix = '---="';

speechProc.stdout.on('data', function (data) {
    var data = data.trim();
    //console.error(data);
    if ( commandRE.test(data) ) {
        nats.publish('humix.sense.speech.event', data.substr(prefix.length, data.length- (prefix.length * 2)));
        console.error('command found:' + data.substr(prefix.length, data.length - (prefix.length * 2)));
    }
});

speechProc.on('close', function(code) {
    console.error('speech proc finished with code:' + code);
});

speechProc.on('error', function (error) {
    console.error(error);
});

//test code start here 
//function testSendAplay() {
//    console.error('send aplay');
//    sendAplay2HumixSpeech(connHumixSpeech, '/home/yhwang/humix/humix-sense/controls/humix-sense-speech/voice/interlude/what.wav');
//    setTimeout(testSendAplay, 5000);
//}
//setTimeout(testSendAplay, 5000);
