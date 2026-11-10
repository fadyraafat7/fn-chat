import React, { useEffect, useState } from 'react';
import { Alert, PermissionsAndroid, Platform, SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { mediaDevices, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCView } from 'react-native-webrtc';

export default function CallScreen({ call, socket, onClose }) {
  const [local, setLocal] = useState(null);
  const [remote, setRemote] = useState(null);
  const [status, setStatus] = useState('جارٍ تجهيز المكالمة...');
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    let stopped = false, pc, stream, remoteReady = false;
    const candidates = [];
    const signal = data => socket.emit('call-signal', { id: call.id, signal: data });
    const fail = error => { if (!stopped) { Alert.alert('تعذرت المكالمة', error?.message || 'تحقق من أذونات الجهاز والاتصال'); onClose(); } };
    const onEnded = data => { if (data.id !== call.id || stopped) return; if (data.reason === 'declined') Alert.alert('F&N', 'تم رفض المكالمة'); onClose(); };
    const onAccepted = async data => {
      if (data.id !== call.id || stopped || !pc) return;
      try { setStatus('جارٍ الاتصال...'); const offer = await pc.createOffer(); await pc.setLocalDescription(offer); signal({ type: 'offer', sdp: offer.sdp }); } catch (e) { fail(e); }
    };
    const onSignal = async ({ id, signal: data }) => {
      if (id !== call.id || stopped || !pc) return;
      try {
        if (data.type === 'candidate') {
          if (!remoteReady) candidates.push(data.candidate);
          else await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else if (data.type === 'offer' || data.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription({ type: data.type, sdp: data.sdp }));
          remoteReady = true;
          for (const candidate of candidates.splice(0)) await pc.addIceCandidate(new RTCIceCandidate(candidate));
          if (data.type === 'offer') { const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); signal({ type: 'answer', sdp: answer.sdp }); }
        }
      } catch (e) { fail(e); }
    };
    socket.on('call-ended', onEnded); socket.on('call-accepted', onAccepted); socket.on('call-signal', onSignal);
    (async () => {
      try {
        if (Platform.OS === 'android') {
          const permissions = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
          if (call.type === 'video') permissions.push(PermissionsAndroid.PERMISSIONS.CAMERA);
          const results = await PermissionsAndroid.requestMultiple(permissions);
          if (permissions.some(p => results[p] !== PermissionsAndroid.RESULTS.GRANTED)) throw new Error('يجب السماح باستخدام الميكروفون والكاميرا حسب نوع المكالمة');
        }
        const rtcConfig = await new Promise((resolve, reject) => socket.timeout(20000).emit('rtc-config', (error, config) => error || config?.error ? reject(new Error(config?.error || 'تعذر تجهيز المكالمة')) : resolve(config)));
        if (stopped) return;
        stream = await mediaDevices.getUserMedia({ audio: true, video: call.type === 'video' ? { facingMode: 'user' } : false });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        setLocal(stream);
        pc = new RTCPeerConnection({ iceServers: rtcConfig.iceServers });
        stream.getTracks().forEach(track => pc.addTrack(track, stream));
        pc.onicecandidate = event => { if (event.candidate) signal({ type: 'candidate', candidate: event.candidate.toJSON() }); };
        pc.ontrack = event => { if (event.streams && event.streams[0]) { setRemote(event.streams[0]); setStatus('متصل'); } };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail(new Error('فشل الاتصال. قد تحتاج الشبكة إلى خادم TURN.')); };
        if (call.role === 'caller') { setStatus('في انتظار الرد...'); socket.emit('call-ready', { id: call.id }); }
        else { setStatus('جارٍ الاتصال...'); socket.timeout(12000).emit('call-answer', { id: call.id, accept: true }, (error, result) => { if (error || result?.error) fail(new Error(result?.error || 'تعذر الرد على المكالمة')); }); }
      } catch (e) { fail(e); }
    })();
    return () => { stopped = true; socket.off('call-ended', onEnded); socket.off('call-accepted', onAccepted); socket.off('call-signal', onSignal); socket.emit('call-end', { id: call.id }); if (pc) pc.close(); if (stream) stream.getTracks().forEach(t => t.stop()); };
  }, [call.id, socket]);
  const toggleMute = () => { if (!local) return; local.getAudioTracks().forEach(t => { t.enabled = muted; }); setMuted(!muted); };
  return <SafeAreaView style={styles.screen}><Text style={styles.title}>F&N · {call.type === 'video' ? 'مكالمة فيديو' : 'مكالمة صوتية'}</Text><Text style={styles.status}>{status}</Text><View style={styles.stage}>{call.type === 'video' && remote ? <RTCView streamURL={remote.toURL()} style={styles.remote} objectFit="cover" /> : <Text style={styles.heart}>♡</Text>}{call.type === 'video' && local && <RTCView streamURL={local.toURL()} style={styles.local} objectFit="cover" mirror />}</View><View style={styles.controls}><TouchableOpacity style={styles.mute} onPress={toggleMute}><Text style={styles.text}>{muted ? 'تشغيل الميكروفون' : 'كتم الميكروفون'}</Text></TouchableOpacity><TouchableOpacity style={styles.end} onPress={onClose}><Text style={styles.text}>إنهاء المكالمة</Text></TouchableOpacity></View></SafeAreaView>;
}
const styles = StyleSheet.create({ screen:{flex:1,backgroundColor:'#292329',padding:20},title:{color:'white',fontWeight:'800',fontSize:18,textAlign:'center',marginTop:15},status:{color:'#ccb4bb',textAlign:'center',marginTop:8},stage:{flex:1,alignItems:'center',justifyContent:'center',marginVertical:20},remote:{width:'100%',height:'100%',borderRadius:20},local:{position:'absolute',right:10,top:10,width:100,height:150,borderRadius:12},heart:{fontSize:100,color:'#d1a2ad'},controls:{flexDirection:'row',justifyContent:'center',gap:12,marginBottom:20},mute:{backgroundColor:'#66545b',padding:15,borderRadius:15},end:{backgroundColor:'#b74353',padding:15,borderRadius:15},text:{color:'white',fontWeight:'700'} });
