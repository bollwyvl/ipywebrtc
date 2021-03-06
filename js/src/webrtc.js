widgets = require('@jupyter-widgets/base')
_ = require("underscore")
require('webrtc-adapter')
mqtt = require('mqtt')
var semver_range = '~' + require('../package.json').version;

// for dev, when it slows down the browser
var media_cleanup_callbacks = []
var add_media_cleanup = function(callback, context) {
    media_cleanup_callbacks.push(_.bind(callback, context))
}
window.media_cleanup = function() {
    _.each(media_cleanup_callbacks, function(callback) {
        callback()
    })
    media_cleanup_callbacks = []
}
var MediaStreamModel = widgets.DOMWidgetModel.extend({
    defaults: function() {
        return _.extend(widgets.DOMWidgetModel.prototype.defaults(), {
            _model_name: 'MediaStreamModel',
            _view_name: 'MediaStreamView',
            _model_module: 'jupyter-webrtc',
            _view_module: 'jupyter-webrtc',
            _model_module_version: semver_range,
             _view_module_version: semver_range,
         })
    },
    initialize: function() {
        MediaStreamModel.__super__.initialize.apply(this, arguments);
        // we don't have any stream
        //this.stream = Promise.resolve(null)
        this.stream = new Promise((resolve, reject) => {
            this.stream_resolved = resolve;
        })
    }
});

var MediaStreamView = widgets.DOMWidgetView.extend({

    initialize: function() {
        var el = document.createElement('video')
        el.setAttribute('autoplay', '')
        window.last_media_view = this;
        this.setElement(el);
        MediaStreamView.__super__.initialize.apply(this, arguments);
    },

    render: function() {
        var that = this;
        that.model.stream.then(function(stream) {
            that.el.srcObject = stream;
            that.el.play()
        })
    }

});

var CameraStreamModel = MediaStreamModel.extend({
    defaults: function() {
        return _.extend(MediaStreamModel.prototype.defaults(), {
            _model_name: 'CameraStreamModel',
            audio: true,
            video: true
        })
    },
    initialize: function() {
        CameraStreamModel.__super__.initialize.apply(this, arguments);
        this.stream = navigator.mediaDevices.getUserMedia({audio: this.get('audio'), video: this.get('video')});
        window.last_camera_stream = this;
        this.on('msg:custom', _.bind(this.custom_msg, this));
    },
    custom_msg: function(content) {
        if(content.msg == 'close') {
            this.close()
        }
    },
    close: function() {
        return this.stream.then((stream) => {
            stream.getTracks().forEach((track) => {
                track.stop()
            })
        })
    }
});

var VideoStreamModel = MediaStreamModel.extend({
    defaults: function() {
        return _.extend(MediaStreamModel.prototype.defaults(), {
            _model_name: 'VideoStreamModel',
            //_view_name: 'VideoView',
            url: 'https://webrtc.github.io/samples/src/video/chrome.mp4',
            //controls: true,
            play: true,
            loop: true,
            data: null
        })
    },
    initialize: function() {
        // Get the camera permissions
        VideoStreamModel.__super__.initialize.apply(this, arguments);
        window.last_video = this
        this.video = document.createElement('video')
        this.source = document.createElement('source')
        if(this.get('url')) {
            this.source.setAttribute('src', this.get('url'))
            this.video.appendChild(this.source)
        }
        if(this.get('data')) {
            var ar = new Uint8Array(last_video.get('data').buffer)
            this.video.src = window.URL.createObjectURL(new Blob([ar]));
        }
        var that = this
        this.stream = new Promise((resolve, reject) => {
            that.stream_resolved = resolve;
        })
        this.capture_stream()
        this.on('change:play', this.update_play, this)
        this.on('change:loop', this.update_loop, this)
        add_media_cleanup(function() {
            this.set('play', false)
            console.log('cleanup: stopped video')
            this.stream.then((stream) => {
                stream.getTracks().forEach((track) => track.stop())
            })
        }, this)
    },
    capture_stream: function() {
        if(this.video.captureStream || this.video.mozCaptureStream) {
            // following https://github.com/webrtc/samples/blob/gh-pages/src/content/capture/video-pc/js/main.js
            var make_stream = _.once(_.bind(function() {
                if(this.video.captureStream) {
                    console.info('normal captureStream')
                    this.stream_resolved(this.video.captureStream())
                } else if(this.video.mozCaptureStream) {
                    console.info('falling back to mozCaptureStream')
                    this.stream_resolved(this.video.mozCaptureStream())
                }
            }, this))
            // see https://github.com/webrtc/samples/pull/853
            this.video.oncanplay = make_stream
            //this.video.onplay = make_stream
            if(this.video.readyState >= 3) {
                make_stream()
            }
            //this.stream = Promise.resolve(this.video.captureStream())
            this.update_play()
            this.update_loop()
        } else {
            console.log('captureStream not supported for this browser')
        }
    },
    update_play: function() {
        if(this.get('play'))
            this.video.play()
        else
            this.video.pause()
        console.log('play/pause', this.get('play'))
    },
    update_loop: function() {
        this.video.loop = this.get('loop')
        console.log('loop', this.get('loop'))
    }
});

var WebRTCRoomModel = widgets.DOMWidgetModel.extend({
    defaults: function() {
        return _.extend(widgets.DOMWidgetModel.prototype.defaults(), {
            _model_name: 'WebRTCRoomModel',
            //_view_name: 'WebRTCRoomView',
            _model_module: 'jupyter-webrtc',
            //_view_module: 'jupyter-webrtc',
            _model_module_version: semver_range,
            _view_module_version: semver_range,
            room: 'room',
            stream: null,
            id: widgets.uuid(),
            nickname: 'anonymous',
            peers: [],
            streams: []
        })
    },
    log: function() {
        var args = [this.get('nickname') + ' ' +this.get('id') +': ']
        args = args.concat(Array.prototype.slice.call(arguments))
        console.log.apply(null, args);
    },
    initialize: function() {
        WebRTCRoomModel.__super__.initialize.apply(this, arguments);
        this.set('id',  widgets.uuid())
        this.id = this.get('id')
        this.room = this.get('room')
        this.peers = {} // id (string) to WebRTCPeerModel
        window['last_webrtc_room_' + this.id] = this
        var stream = this.get('stream')
        if(stream) {
            this.set('streams', [stream])
        }
        this.save_changes()
        this.on('msg:custom', _.bind(this.custom_msg, this));
    },
    custom_msg: function(content) {
        if(content.msg == 'close') {
            this.close()
        }
    },
    close: function() {
        this.get('peers').forEach((peer) => peer.close())
    },
    create_peer: function(from_id) {
        return this.widget_manager.new_widget({
                model_name: 'WebRTCPeerModel',
                model_module: 'jupyter-webrtc',
                model_module_version: semver_range,
                view_name: 'WebRTCPeerView',
                view_module: 'jupyter-webrtc',
                view_module_version: semver_range,
                widget_class: 'webrtc.WebRTCPeerModel', // ipywidgets6
            }, {
                stream_local: this.get('stream'),
                id_local: this.get('id'),
                id_remote: from_id
        }).then(_.bind(function(peer) {
            peer.peer_msg_send = _.bind(function(msg) {
                msg.id = this.get('id')
                msg.to = from_id
                this.log('send to peer', msg)
                //console.log('sending to room', msg, from_id)
                peer.save_changes()
                this.room_msg_send(msg)
            }, this)
            return peer
        }, this))
    },
    listen_to_remote_stream: function(peer) {
        peer.on('change:stream_remote', _.once(_.bind(function(){
            this.log('add remote stream')
            var streams = this.get('streams').slice()
            var stream = peer.get('stream_remote')
            streams.push(stream)
            this.set('streams', streams)
            this.save_changes()
        }, this)))
        peer.on('change:connected', _.bind(function() {
            var connected = peer.get('connected')
            this.log('changed connected status for ', peer.get('id_remote'), 'to', connected)
            if(!connected) {
                var streams = this.get('streams').slice()
                var stream = peer.get('stream_remote')
                streams = _.without(streams, stream)
                this.set('streams', streams)

                var peers = this.get('peers').slice()
                peers = _.without(peers, peer)
                this.set('peers', peers)

                delete this.peers[peer.get('id_remote')]
                this.save_changes()
            }
        }, this))
    },
    on_room_msg: function(msg) {
        var from_id = msg.id;
        if(msg.id == this.id)
            return; // skip my own msg'es
        if(msg.type == 'join') {
            this.log('join from', msg.id)
            this.peers[from_id] = this.create_peer(from_id).then(_.bind(function(peer) {
                this.listen_to_remote_stream(peer)
                peer.join().then(_.bind(function() {
                    var peers = this.get('peers').slice()
                    peers.push(peer)
                    this.set('peers', peers)
                    this.save_changes()
                }, this))
                return peer
            }, this))
            this.log(': added peer', from_id)
            return peer;
        } else if(msg.id) {
            if(msg.to != this.id) {
                return
            }
            if(!this.peers[msg.id]) {
                this.peers[from_id] = this.create_peer(from_id).then(_.bind(function(peer) {
                    this.listen_to_remote_stream(peer)
                    var peers = this.get('peers').slice()
                    peers.push(peer)
                    this.set('peers', peers)
                    this.save_changes()
                    return peer
                }, this))
                this.log('added peer', from_id)
            }
            var peer = this.peers[msg.id]
            if(peer) {
                //console.log(this.id, ': peer', msg.id, peer, this, this.cid)
                peer.then(_.bind(function(peer) {
                    this.log('sending from', msg.id, ' to', msg.to, msg)
                    peer.on_peer_msg(msg)
                }, this))
            } else {
                console.error('sending to unknown peer', msg.id)
            }
        } else {
            console.error('expected a to id to be present')
        }
    }
}, {
serializers: _.extend({
    stream: { deserialize: widgets.unpack_models },
    peers: { deserialize: widgets.unpack_models },
    }, widgets.DOMWidgetModel.serializers)
});

var global_rooms = {}

var WebRTCRoomLocalModel = WebRTCRoomModel.extend({
    defaults: function() {
        return _.extend(WebRTCRoomModel.prototype.defaults(), {
            _model_name: 'WebRTCRoomLocalModel',
        })
    },
    initialize: function() {
        WebRTCRoomLocalModel.__super__.initialize.apply(this, arguments);
        this.join()
    },
    join: function() {
        var room = this.get('room');
        console.log('joining room', room)
        var callbacks = global_rooms[room] || []
        callbacks.push(_.bind(this.on_room_msg, this))
        global_rooms[room] = callbacks
        this.room_msg_send({type: 'join', id: this.get('id')})

    },
    room_msg_send: function(msg) {
        var room = this.get('room');
        console.log('send to room', room, msg, global_rooms[room])
        _.each(global_rooms[room], function(callback) {
            callback(msg)
        })

    },
});

var WebRTCRoomMqttModel = WebRTCRoomModel.extend({
    defaults: function() {
        return _.extend(WebRTCRoomModel.prototype.defaults(), {
            _model_name: 'WebRTCRoomMqttModel',
            server: 'wss://iot.eclipse.org:443/ws'
        })
    },
    initialize: function() {
        WebRTCRoomMqttModel.__super__.initialize.apply(this, arguments);
        console.log('connecting to', this.get('server'))
        this.mqtt_client = mqtt.connect(this.get('server'))
        var client = this.mqtt_client
        this.topic_join = 'jupyter-webrtc/' + this.get('room') +'/join'
        //this.topic_present = 'jupyter-webrtc/' +this.room +'/present'
        this.mqtt_client.on('connect', _.bind(function () {
          client.subscribe(this.topic_join)
          //client.subscribe(this.topic_present)
          //client.publish('jupyter-webrtc/room-a/present', 'you|me', {retain:true})
          //client.publish('jupyter-webrtc/room-a/join', 'Hello mqtt')
        }, this))
        client.on('message', _.bind(function (topic, message) {
            var msg = JSON.parse(message)
            console.log('msg received', message, msg)
            if(topic == this.topic_join) {
                this.on_room_msg(msg)
            }
        }, this))
        this.join()
    },
    join: function() {
        this.room_msg_send({type: 'join', id: this.get('id')})

    },
    room_msg_send: function(msg) {
        var text = JSON.stringify(msg)
        console.log('send to mqtt channel', msg)
        this.mqtt_client.publish(this.topic_join, text)
    }
});

var WebRTCPeerModel = widgets.DOMWidgetModel.extend({
    defaults: function() {
        return _.extend(widgets.DOMWidgetModel.prototype.defaults(), {
            _model_name: 'WebRTCPeerModel',
            _view_name: 'WebRTCPeerView',
            _model_module: 'jupyter-webrtc',
            _view_module: 'jupyter-webrtc',
            _model_module_version: semver_range,
            _view_module_version: semver_range
        })
    },
    log: function() {
        var args = [this.get('id') +': ']
        args = args.concat(Array.prototype.slice.call(arguments))
        console.log.apply(null, args);
    },
    on_peer_msg: function(msg) {
        var info = msg;
        var that = this;
        this.log('peer msg', info)
        if(info.sdp) {
            // the other party send us the sdp
            this.log(name, 'got sdp')
            var sdp_remote = new RTCSessionDescription(info.sdp)
            var remote_description_set = this.pc.setRemoteDescription(sdp_remote)
            if(!this.initiator) {
                console.log(this.get('id_local'), 'did not initiate, reply with answer')
                // if we didn't initiate, we should respond with an answer
                // now we create an answer, and send a sdp back
                Promise.all([remote_description_set, this.tracks_added])
                .then(() => this.pc.createAnswer())
                .then((sdp) => {
                    console.log('sending sdp', this.id)
                    that.send_sdp(sdp)
                    that.pc.setLocalDescription(sdp)
                })
            }
        } else if (info.candidate) {
            var c = new RTCIceCandidate(info.candidate);
            this.pc.addIceCandidate(c)
        }
    },
    initialize: function() {
        WebRTCPeerModel.__super__.initialize.apply(this, arguments);

        var that = this;
        var id = this.id = this.get('id_local')
        this.initiator = false

        var pc_config = {"iceServers": [{"urls": ["stun:stun.l.google.com:19302", 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302']}]};
        //var pc_config = null;
        this.pc = new RTCPeerConnection(pc_config);

        window['last_webrtc_'+id] = this
        //this.other = null

        if(this.get('stream_local')) {
            this.tracks_added = new Promise((resolve, reject) => {
                that.get('stream_local').stream.then((stream) => {
                    console.log('add stream', stream)
                    //this.pc.addStream(stream) (this crashes/hangs chrome)
                    // so we use the addTrack api
                    stream.getTracks().forEach(
                        function(track) {
                          that.pc.addTrack(
                            track,
                            stream
                          );
                        }
                    );
                    resolve()
                }) // TODO: catch/reject?
            })
        } else {
            console.log('no stream')
            this.tracks_added = Promise.resolve()
        }
        this.tracks_added.then(() => console.log('tracks added'))
        this.pc.onicecandidate = _.bind(function(event) {
            console.log(this.id, 'onicecandidate', event.candidate)
            this.event_candidate = event
            this.send_ice_candidate(event.candidate)
        }, this)
        this.pc.onopen = _.bind(function() {
            console.log('onopen', name)
        }, this)
        this.pc.onaddstream = _.bind(function(evt) {
            console.log('onaddstream', name)
            this.widget_manager.new_widget({
                    model_name: 'MediaStreamModel',
                    model_module: 'jupyter-webrtc',
                    model_module_version: semver_range,
                    view_name: 'MediaStreamView',
                    view_module: 'jupyter-webrtc',
                    view_module_version: semver_range,
                    widget_class: 'webrtc.MediaStreamModel', // ipywidgets6
                }).then(function(model) {
                    model.stream = Promise.resolve(evt.stream); // TODO: not nice to just set the promise...
                    that.set('stream_remote', model)
                    //mo
                    that.save_changes()
                    console.log(that.id, ': added stream_remote')
                    return model;
                });
        }, this)
        this.pc.onconnecting = _.bind(function() {
            console.log('onconnecting', name)
        }, this)
        this.pc.oniceconnectionstatechange = _.bind(function() {
            console.log(this.id, 'ICE connection state', this.pc.iceConnectionState);
            if(this.pc.iceConnectionState == 'disconnected') {
                this.set('connected', false)
                this.save_changes()
            }
            if(this.pc.iceConnectionState == 'connected') {
                this.set('connected', true)
                this.save_changes()
            }
            // TODO: can we recover from this?
            if(this.pc.iceConnectionState == 'failed') {
                this.set('connected', false)
                this.save_changes()
            }
        }, this)
        /*
        this doesn't seem to exist in chrome at least, lets rely on ice state change above
        this.pc.onconnectionstatechange = _.bind(function() {
            console.log(this.id, 'connection state', this.pc.connectionState);
            if(this.pc.connectionState == 'disconnected') {
                this.set('connected', false)
                this.save_changes()
            }
            if(this.pc.connectionState == 'connected') {
                this.set('connected', true)
                this.save_changes()
            }
        }, this)
        */
        this.on('msg:custom', _.bind(this.custom_msg, this));
        //this.disconnect = _.once(_.bind(this.disconnect, this))
        window.addEventListener('beforeunload', function () {
            that.close()
        }, false);
    },
    custom_msg: function(content) {
        console.log('custom msg', content)
        if(content.msg == 'connect') {
            this.connect()
        } else if(content.msg == 'close') {
            this.close()
        } else {
            this.disconnect()
        }
    },
    close: function() {
        //console.log('disconnect')
        this.pc.close() // does not trigger ice conncection status changes
        this.set('connected', false)
        this.save_changes()
    },
    join: function() {
        this.initiator = true
        var that = this;
        var after_stream
        return this.tracks_added.then(() => {
            return new Promise((resolve, reject) => {
                var id = that.get('id')
                var offer = {
                  offerToReceiveAudio: 1,
                  offerToReceiveVideo: 1
                };

                this.pc.createOffer(offer)
                .then((sdp)  => {
                    console.log('set local desc');
                    that.pc.setLocalDescription(sdp)
                    console.log(that.id, 'send sdp')
                    that.send_sdp(sdp)
                    resolve()
                })
                .catch(e => {
                    console.error(e)
                    reject(e)
                });
                return that
            })
        })
    },
    send_sdp: function(sdp) {
        this.broadcast({sdp:sdp})
    },
    send_ice_candidate: function(candidate) {
        this.broadcast({candidate:candidate})
    },
    broadcast: function(msg) {
        this.peer_msg_send(msg)

    },
}, {
serializers: _.extend({
    stream: { deserialize: widgets.unpack_models },
    peers: { deserialize: widgets.unpack_models },
    }, widgets.DOMWidgetModel.serializers)
});

var WebRTCPeerView = widgets.DOMWidgetView.extend({

    initialize: function() {
        var el = document.createElement('video')
        window.last_media_view = this;
        this.setElement(el);
        WebRTCPeerView.__super__.initialize.apply(this, arguments);
    },

    render: function() {
        var that = this;
        that.model.stream.then(function(stream) {
            that.el.srcObject = stream;
            that.el.play()
        })
    }

});

var MediaRecorderModel = widgets.DOMWidgetModel.extend({
    defaults: function() {
        return _.extend(widgets.DOMWidgetModel.prototype.defaults(), {
            _model_name: 'MediaRecorderModel',
            //_view_name: 'MediaStreamView',
            _model_module: 'jupyter-webrtc',
            //_view_module: 'jupyter-webrtc',
            _model_module_version: semver_range,
            //_view_module_version: semver_range,
            record: false,
            mime_type: 'video/webm'
         })
    },
    initialize: function() {
        MediaRecorderModel.__super__.initialize.apply(this, arguments);
        window.last_media_recorder = this
        var change_record = () => {
            if(this.get('record')) {
                this.record()
            } else {
                this.stop()
            }
        }
        this.recorder = null;
        this.chunks = []
        this.on('change:record', change_record)
    },
    record: function() {
        console.log('start recording')
        var streamModel = this.get('stream');
        if(!streamModel) {
            console.error('no stream')
            return
        }
        streamModel.stream.then((stream) => {
            console.log('got stream, firing up recorder')
            this.recorder = new MediaRecorder(stream, {
              audioBitsPerSecond : 128000,
              videoBitsPerSecond : 2500000,
              mimeType : this.get('mime_type')
            })
            this.recorder.start()
            this.recorder.ondataavailable = (e) => {
                this.chunks.push(e.data);
               console.log('got chunk of length', e.data.size)
            }
        })
    },
    stop: function() {
        console.log('stopping recorder')
        this.recorder.onstop = (e) => {
            var recorder = this.recorder; // keep a local reference
            var chunks = this.chunks; // and a (shallow) copy of the array of chunks
            this.recorder = null; // before we set it to null
            this.chunks = []
            console.log('assembling blob')
            var blob = new Blob(chunks, { 'type' : this.get('mime_type') });
            //var audioURL = window.URL.createObjectURL(blob);
            //  audio.src = audioURL;
            window.last_blob = blob;
            var reader = new FileReader()
            reader.readAsArrayBuffer(blob)
            reader.onloadend = () => {
                window.last_result = reader.result
                window.last_reader = reader
                var bytes = new Uint8Array(reader.result)
                console.log('assembled ', reader.result, reader.result.byteLength, chunks, this.chunks)
                this.set('data', bytes)
                this.save_changes()
            }
        }
        this.recorder.stop() 
    }
}, {
serializers: _.extend({
    stream: { deserialize: widgets.unpack_models },
    // serialise should be define, otherwise it takes the JSON path
    data: { deserialize: (v) => v, serialize: (v) => v} ,
    }, widgets.DOMWidgetModel.serializers)
});

module.exports = {
    MediaStreamModel: MediaStreamModel,
    MediaStreamView: MediaStreamView,
    CameraStreamModel: CameraStreamModel,
    VideoStreamModel:VideoStreamModel,
    WebRTCPeerModel: WebRTCPeerModel,
    WebRTCPeerView: WebRTCPeerView,
    WebRTCRoomModel: WebRTCRoomModel,
    WebRTCRoomLocalModel: WebRTCRoomLocalModel,
    WebRTCRoomMqttModel: WebRTCRoomMqttModel,
    MediaRecorderModel:MediaRecorderModel
}
