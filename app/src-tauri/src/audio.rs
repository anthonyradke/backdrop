//! What's playing on the computer, as frequency bands, for scenes that react to music. Windows hands
//! a copy of the speakers' signal to anyone who asks (WASAPI loopback), the same source Wallpaper
//! Engine uses. Nothing is stored or sent anywhere: samples are turned into band levels and dropped.
//! Capture only runs while a player keeps asking, and stops a few seconds after the last request.
#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Bands per channel; shaders also want 32 and 16, which the player averages down from these.
pub const BANDS: usize = 64;
const FFT: usize = 1024;
/// How much of a band's level is left after each analysis, so bars fall instead of flicker.
const DECAY: f32 = 0.82;

struct Shared {
    levels: [[f32; BANDS]; 2],
    asked: Option<Instant>,
    running: bool,
}

static STATE: Mutex<Shared> = Mutex::new(Shared { levels: [[0.0; BANDS]; 2], asked: None, running: false });

/// The latest levels, left then right, 0 to 1. Starts capture if it isn't running.
pub fn spectrum() -> Vec<f32> {
    let mut s = STATE.lock().unwrap();
    s.asked = Some(Instant::now());
    if !s.running && capture::SUPPORTED {
        s.running = true;
        std::thread::Builder::new().name("backdrop-audio".into()).spawn(capture::run).ok();
    }
    s.levels.iter().flatten().copied().collect()
}

fn wanted() -> bool {
    STATE.lock().unwrap().asked.is_some_and(|t| t.elapsed() < Duration::from_secs(5))
}

fn stopped() {
    let mut s = STATE.lock().unwrap();
    s.running = false;
    s.levels = [[0.0; BANDS]; 2];
}

/// In-place radix-2 FFT of `FFT` points.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let angle = -2.0 * std::f32::consts::PI / len as f32;
        let (wr, wi) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * cr - im[b] * ci, re[b] * ci + im[b] * cr);
                (re[b], im[b]) = (re[a] - tr, im[a] - ti);
                re[a] += tr;
                im[a] += ti;
                (cr, ci) = (cr * wr - ci * wi, cr * wi + ci * wr);
            }
        }
        len <<= 1;
    }
}

/// Levels of `FFT` samples, in bands spaced logarithmically from 40 Hz up.
fn analyze(samples: &[f32], rate: f32) -> [f32; BANDS] {
    let mut re = [0f32; FFT];
    let mut im = [0f32; FFT];
    for (i, s) in samples.iter().take(FFT).enumerate() {
        let hann = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT - 1) as f32).cos();
        re[i] = s * hann;
    }
    fft(&mut re, &mut im);
    let top = (rate / 2.0).min(18_000.0);
    let hz_per_bin = rate / FFT as f32;
    let mut out = [0f32; BANDS];
    for (b, level) in out.iter_mut().enumerate() {
        let edge = |x: f32| 40.0 * (top / 40.0).powf(x / BANDS as f32);
        let first = (edge(b as f32) / hz_per_bin).floor() as usize;
        let last = ((edge(b as f32 + 1.0) / hz_per_bin).ceil() as usize).clamp(first + 1, FFT / 2);
        let peak = (first..last).map(|i| (re[i] * re[i] + im[i] * im[i]).sqrt()).fold(0.0, f32::max);
        // Decibels, with -60 dB as silence. A full-scale sine under the window peaks near FFT / 4.
        let db = 20.0 * (peak / (FFT as f32 / 4.0)).max(1e-6).log10();
        *level = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
    }
    out
}

/// Feeds interleaved audio in and publishes levels every time enough has arrived.
struct Analyzer {
    rate: f32,
    channels: usize,
    buffers: [Vec<f32>; 2],
}

impl Analyzer {
    fn new(rate: u32, channels: usize) -> Self {
        Self { rate: rate as f32, channels: channels.max(1), buffers: [Vec::with_capacity(FFT * 2), Vec::with_capacity(FFT * 2)] }
    }

    fn push(&mut self, interleaved: impl Iterator<Item = f32>) {
        for (i, s) in interleaved.enumerate() {
            match i % self.channels {
                0 => self.buffers[0].push(s),
                1 => self.buffers[1].push(s),
                _ => {}
            }
        }
        // A mono device feeds both sides.
        if self.channels == 1 {
            let copy = self.buffers[0].clone();
            self.buffers[1] = copy;
        }
        while self.buffers[0].len() >= FFT && self.buffers[1].len() >= FFT {
            let left = analyze(&self.buffers[0][..FFT], self.rate);
            let right = analyze(&self.buffers[1][..FFT], self.rate);
            publish([left, right]);
            // Half overlap keeps the levels moving at about 80 updates a second at 44.1 kHz.
            for b in &mut self.buffers {
                b.drain(..FFT / 2);
            }
        }
    }
}

fn publish(fresh: [[f32; BANDS]; 2]) {
    let mut s = STATE.lock().unwrap();
    for (old, new) in s.levels.iter_mut().zip(fresh) {
        for (o, n) in old.iter_mut().zip(new) {
            *o = n.max(*o * DECAY);
        }
    }
}

#[cfg(windows)]
mod capture {
    use super::*;
    use crate::log;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

    pub const SUPPORTED: bool = true;
    /// 200 ms, in the 100 ns units WASAPI counts in.
    const BUFFER: i64 = 2_000_000;

    /// Runs capture until nobody wants it. Devices come and go, so a failure just tries again.
    pub fn run() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let mut logged = false;
            while wanted() {
                match listen() {
                    Ok(()) => break,
                    Err(e) => {
                        if !logged {
                            log(format!("no audio for scenes: {e}"));
                            logged = true;
                        }
                        std::thread::sleep(Duration::from_secs(2));
                    }
                }
            }
            CoUninitialize();
        }
        stopped();
    }

    unsafe fn listen() -> windows::core::Result<()> {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let format = client.GetMixFormat()?;
        let (channels, rate, bits, align) = {
            let f = &*format;
            (f.nChannels as usize, f.nSamplesPerSec, f.wBitsPerSample, f.nBlockAlign as usize)
        };
        let opened = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, BUFFER, 0, format, None);
        CoTaskMemFree(Some(format as *const _));
        opened?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        let mut analyzer = Analyzer::new(rate, channels);
        let mut heard = std::time::Instant::now();
        while wanted() {
            std::thread::sleep(Duration::from_millis(10));
            let mut waiting = capture.GetNextPacketSize()?;
            // Loopback delivers nothing at all while nothing plays, so the levels fall from here
            // instead of staying where the music stopped.
            if waiting > 0 {
                heard = std::time::Instant::now();
            } else if heard.elapsed() > Duration::from_millis(50) {
                publish([[0.0; BANDS]; 2]);
            }
            while waiting > 0 {
                let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                let samples = frames as usize * channels;
                if silent || data.is_null() {
                    analyzer.push(std::iter::repeat_n(0.0, samples));
                } else if bits == 32 && align == channels * 4 {
                    // The shared-mode mix format is 32-bit float on every current Windows.
                    analyzer.push(std::slice::from_raw_parts(data as *const f32, samples).iter().copied());
                } else if bits == 16 && align == channels * 2 {
                    analyzer.push(std::slice::from_raw_parts(data as *const i16, samples).iter().map(|s| *s as f32 / 32768.0));
                }
                capture.ReleaseBuffer(frames)?;
                waiting = capture.GetNextPacketSize()?;
            }
        }
        client.Stop()?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod capture {
    pub const SUPPORTED: bool = false;
    pub fn run() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f32, rate: f32) -> Vec<f32> {
        (0..FFT).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate).sin()).collect()
    }

    fn loudest(levels: &[f32; BANDS]) -> usize {
        levels.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0
    }

    #[test]
    fn a_tone_lands_in_the_right_band() {
        let rate = 48_000.0;
        let low = loudest(&analyze(&tone(100.0, rate), rate));
        let mid = loudest(&analyze(&tone(1_000.0, rate), rate));
        let high = loudest(&analyze(&tone(10_000.0, rate), rate));
        assert!(low < mid && mid < high, "{low} {mid} {high}");
        assert!(analyze(&tone(1_000.0, rate), rate)[mid] > 0.8);
    }

    #[test]
    fn silence_is_zero_and_nothing_overflows() {
        assert!(analyze(&[0.0; FFT], 48_000.0).iter().all(|v| *v == 0.0));
        let loud = vec![10.0; FFT];
        assert!(analyze(&loud, 48_000.0).iter().all(|v| (0.0..=1.0).contains(v)));
    }

    #[test]
    fn splits_interleaved_channels() {
        let mut a = Analyzer::new(48_000, 2);
        a.push([1.0, 2.0, 3.0, 4.0].into_iter());
        assert_eq!(a.buffers, [vec![1.0, 3.0], vec![2.0, 4.0]]);
        // Surround channels past the front two are ignored.
        let mut a = Analyzer::new(48_000, 3);
        a.push([1.0, 2.0, 9.0].into_iter());
        assert_eq!(a.buffers, [vec![1.0], vec![2.0]]);
    }
}
