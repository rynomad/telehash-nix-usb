
var lob = require('lob-enc');
var fs = require('fs');
var crc = require('crc');
var serialPort = require('serialport');
var net = require('net')
var stream = require('stream')
exports.name = 'nix-usb';
exports.port = 0;
exports.ip = '0.0.0.0';
exports.keepalive = 30000

function error(err)
{
  console.error(err);
  process.exit(1);
}

exports.Buffer = exports.Buffer || require("buffer").Buffer;

// add our transport to this new mesh
exports.mesh = function(mesh, cbExt)
{
  var args = mesh.args||{};
  var telehash = mesh.lib;

  var tp = {pipes:{}};


  // turn a path into a pipe
  tp.pipe = function(link, path, cbPipe){
    if(typeof path != 'object' || path.type != 'nix-usb') return false;
    if(typeof path.port != 'string') return false;
    var id = path.port;
    var pipe = tp.pipes[id];
    //console.log("tp.pipe", id)
    if(pipe) return cbPipe(pipe);
    pipe = new telehash.Pipe('nix-usb',exports.keepalive);

    pipe.path = path;
    tp.pipes[id] = pipe;
    pipe.id = id;
    pipe.link = link;
    pipe.chunks = lob.chunking({size: path.mode == "host" ? 32 : 768, blocking:true}, function receive(err, packet){
      //console.log("got usb packet", packet.head, packet.json)
      if(err || !packet)
      {
        mesh.log.error('pipe chunk read error',err,pipe.id);
        return;
      }
      // handle incoming greeting as a discovery
      if(packet.head.length > 1)
      {
        var greeting = packet.json;
        greeting.pipe = pipe;
        mesh.discovered(greeting);
      }else{
        if (!(packet instanceof exports.Buffer))
          packet = new exports.Buffer(packet)
        mesh.receive(packet, pipe);
        mesh.receive(packet, pipe);
      }
    });
    pipe.onSend = function(packet, link, cb){
      //console.log("pipe onSend")
      if (!(packet instanceof Buffer))
        packet = new Buffer(packet);
      pipe.chunks.send(packet)
      pipe.chunks.send(packet);
      cb();
      //console.log("pipe onSend return")
    }

    pipe.usePacking = function(socket){
      //console.log("usePacking")
      var pack = new stream.Transform({
        transform : function (chunk, enc, cb){
          //console.log(">>>", chunk.length + 1 , chunk.toString('base64'))
          this.push(chunk.toString('base64') + '\n')
          cb()
        },
        flush : function (done){
          done()
        }
      })

      var unpack = new stream.Transform({
        transform : function (chunk, enc, cb){
        //console.log("<<<", chunk.length, chunk.toString())
          chunk.toString().split("\n").forEach((chnk) => {
            if (chnk)
              this.push(new Buffer(chnk,'base64'))
          })
          cb()
        },
        flush : function (done){
          done()
        }
      })

      pipe.sock = socket;

      socket.pipe(unpack).pipe(pipe.chunks).pipe(pack).pipe(socket);
    }

    pipe.close = function(cb){
      sPort.close(function(msg){
        cb()
      })
    }

    var ttyConnect = () => {
      console.log('ttyconnect')
      var sock = net.createConnection(path.port)
      sock.on('error', remove.bind(pipe))
      sock.on('close', remove.bind(pipe))
      pipe.usePacking(sock)
    }

    if (path.mode === "device-tty"){
      ttyConnect()
      return;
    }

    var sPort = new serialPort.SerialPort(path.port, {  baudrate: 115200}, false);

    var remove = function remove(stat){
      this._close = null;
      this.message = stat;
      this.removed = true;
      //TODO: trigger some sort of discovery callback
      tp.pipes[this.id] = null;
      console.log("remove",stat)
      this.emit("close", this);
      this.removeAllListeners()
      tp.discover(false)
      setTimeout(() => tp.discover({mode : {mode : path.mode, vendorId : path.vendorId, productId : path.productId}}), 5000)
    }

    sPort.open(function (err) {
      if (err) {
        console.log("SERIAL ERROR", err)
        return remove.bind(pipe)(err)
      };

      sPort.on('error', remove.bind(pipe));
      sPort.on('close', remove.bind(pipe));
      if (path.mode === "host-tty"){
        console.log("usePacking")
        process.on('exit', () => {
          sPort.write("'\n")
        })
        sPort.on('data', (data) => {
          if (data[0] === ("'").charCodeAt(0)){
            console.log("got apostraphe")
            sPort.close()
          }
        })
        
        
        
        sPort.once('data', (d) => {
          console.log("got data", d.toString())
          if (d.toString().indexOf("login:") === 0 || d.toString().indexOf("0000000") == 0){
            console.log('got tty bounce')
            pipe.usePacking(sPort)
            pipe.chunks.send(lob.encode(mesh.json()))
          }
        })
        sPort.write("0000000000000000\n")
      } else {
        sPort.pipe(pipe.chunks).pipe(sPort);
        pipe.chunks.send(lob.encode(mesh.json()));
      }
//sPort.on('data',function(data){ console.log('serial data',data,data.toString());sPort.write(zero);});
//      sPort.write(zero);
      // send discovery greeting
      console.log("send greeting")
      
    });


    cbPipe(pipe);
  };

  // return our current addressible paths
  tp.paths = function(){
    return [];
  };

  var discoverinterval;
  var potentials = {};

  // enable discovery mode, broadcast this packet
  tp.discover = function(OPTS, cbDisco){
    console.log("DISCOVER")
    if (discoverinterval)
      clearInterval(discoverinterval)
    // turn off discovery
    if(!OPTS)
    {
      console.log("no opts")
      return (cbDisco) ? cbDisco() : undefined;
    }

    var modes = OPTS.modes ? OPTS.modes : [OPTS.mode || { mode : "host"}];

    modes.forEach(function (mode_opts, idx) {
      'use strict';
      var opts = Object.assign(OPTS, mode_opts)
      var mode = opts.mode;
      var port = "/tmp/device-tty";

      if (mode == "device-tty"){
        tp.pipe(false, {type:'nix-usb',port:port, mode : mode}, function(pipe, err){
          if (err)
            console.log("unable to discover usb in device-tty mode")
        })
      } else {
        discoverinterval = setInterval(function(){
          serialPort.list(function (err, ports) {
            if (err){
              return cbDisco(err)
            }

            ports.forEach(function(port) {
              if (!tp.pipes[port.comName]) {
                if (opts.devName && port.comName !== opts.devName) {
                  return;
                } else if (opts.vendorId && port.vendorId !== opts.vendorId) {
                  return;
                }
                //console.log("see device")

                setTimeout(function(){
                  tp.pipe(false, {type:'nix-usb',port:port.comName, mode : mode}, function(pipe){
                    //console.log("discovered pipe", port.comName, pipe)
                    return (cbDisco)? cbDisco() : undefined;
                  })
                }, opts.wait || 0)
              }
            });
          });
        }, opts.timer || 500)
      } 
    })

    
  }
  cbExt(null, tp)
}
