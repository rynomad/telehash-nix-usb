
var lob = require('lob-enc');
var fs = require('fs');
var crc = require('crc');
var serialPort = require('serialport');

exports.name = 'nix-usb';
exports.port = 0;
exports.ip = '0.0.0.0';

function error(err)
{
  console.error(err);
  process.exit(1);
}

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
    //console.log("created pipe")
    pipe.path = path;
    tp.pipes[id] = pipe;
    pipe.id = id;
    pipe.link = link;
    pipe.chunks = lob.chunking({size:32, blocking:true}, function receive(err, packet){
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
        mesh.receive(packet, pipe);
      }
    });
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

    }

    sPort.open(function (err) {
      if (err) {
        console.log("SERIAL ERROR", err)
        return remove.bind(pipe)(err)
      };
      sPort.on('error', remove.bind(pipe));
      sPort.on('close', remove.bind(pipe));
      sPort.pipe(pipe.chunks);
      pipe.chunks.pipe(sPort);
//sPort.on('data',function(data){ console.log('serial data',data,data.toString());sPort.write(zero);});
//      sPort.write(zero);
      // send discovery greeting
      pipe.chunks.send(lob.encode(mesh.json()));
    });

    pipe.onSend = function(packet, link, cb){
      //console.log("pipe onSend")
      pipe.chunks.send(packet);
      cb();
      //console.log("pipe onSend return")
    }

    pipe._close = function(cb){
      sPort.close(function(msg){
        cb()
      })
    }
    cbPipe(pipe);
  };

  // return our current addressible paths
  tp.paths = function(){
    return [];
  };

  var discoverinterval;
  var potentials = {};

  // enable discovery mode, broadcast this packet
  tp.discover = function(opts, cbDisco){
    console.log("DISCOVERYYYYY")
    if (discoverinterval)
      clearInterval(discoverinterval)
    // turn off discovery
    if(!opts)
    {
      console.log("no opts")
      return (cbDisco) ? cbDisco() : undefined;
    }

    discoverinterval = setInterval(function(){
      //console.log("interval")
      serialPort.list(function (err, ports) {
        if (err){
          return cbDisco(err)
        }


        ports.forEach(function(port) {
          //console.log("ports", port, opts)
          if (!tp.pipes[port.comName]) {
            if (opts.devName && port.comName !== opts.devName) {
              return;
            } else if (opts.vendorId && port.vendorId !== opts.vendorId) {
              return;
            }
            //console.log("see device")
            setTimeout(function(){
              //console.log("after timeout")
              tp.pipe(false, {type:'nix-usb',port:port.comName, vendorId: port.vendorId, productId : port.productId}, function(pipe){
                //console.log("discovered pipe", port.comName, pipe)
                return (cbDisco)? cbDisco() : undefined;
              })
            }, opts.wait || 10)
          }
        });
      });
    }, opts.timer || 500)
  }
  cbExt(null, tp)
}
