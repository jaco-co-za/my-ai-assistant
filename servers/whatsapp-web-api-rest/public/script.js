document.addEventListener('DOMContentLoaded', () => {

  const qrOptions = {
    width: 264,
    height: 264,
    colorDark: '#323232',
    colorLight: '#FFFFFF',
    correctLevel: QRCode.CorrectLevel.H,
    logo: '/public/whatsapp.png',
    logoWidth: 64,
    logoHeight: 64,
    logoBackgroundTransparent: true
  };

  const eventSource = new EventSource('/sse');
  eventSource.onmessage = ({ data }) => {
    document.getElementById('qr').innerHTML = '';
    try {
      const response = JSON.parse(data);
      const qr = response?.qr;
      document.getElementById('text').innerHTML = response?.text;
      if (qr !== '') new QRCode(document.getElementById('qr'), { text: qr, ...qrOptions });
    } catch (e) {
      console.log(e);
      document.getElementById('text').innerHTML = 'Event source error!';
    }
  };
});