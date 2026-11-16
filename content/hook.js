// Runs in the page itself, before the page's own code, and notices calls:
// a call is a WebRTC connection that is connected and receiving audio. That
// holds for Meet and WhatsApp alike, and it never fires for a voice note or
// Meet's lobby, which use the mic without a connection.
(() => {
  const Native = window.RTCPeerConnection;
  if (!Native || Native.__scribe) return;
  const connections = new Set();

  class ScribePeerConnection extends Native {
    constructor(...args) {
      super(...args);
      connections.add(this);
      this.addEventListener('connectionstatechange', () => {
        if (this.connectionState === 'closed') connections.delete(this);
      });
    }
    close() {
      connections.delete(this);
      return super.close();
    }
  }
  ScribePeerConnection.__scribe = true;
  window.RTCPeerConnection = ScribePeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = ScribePeerConnection;

  const inCall = () => {
    for (const pc of connections) {
      const connected = pc.connectionState === 'connected'
        || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
      const hearing = pc.getReceivers().some((r) => r.track && r.track.kind === 'audio' && r.track.readyState === 'live');
      if (connected && hearing) return true;
    }
    return false;
  };

  setInterval(() => window.postMessage({ __scribe: 'rtc', live: inCall() }, location.origin), 1000);
})();
