/*
 * Stream Controller
*/

import BinarySearch from '../utils/binary-search';
import { BufferHelper } from '../utils/buffer-helper';
import TransmuxerInterface from '../demux/transmuxer-interface';
import Event from '../events';
import { FragmentState } from './fragment-tracker';
import Fragment, { ElementaryStreamTypes } from '../loader/fragment';
import PlaylistLoader from '../loader/playlist-loader';
import * as LevelHelper from './level-helper';
import TimeRanges from '../utils/time-ranges';
import { ErrorDetails } from '../errors';
import { logger } from '../utils/logger';
import { alignStream } from '../utils/discontinuities';
import { findFragmentByPDT, findFragmentByPTS } from './fragment-finders';
import GapController from './gap-controller';
import BaseStreamController, { State } from './base-stream-controller';
import FragmentLoader from '../loader/fragment-loader';

const TICK_INTERVAL = 100; // how often to tick in ms

export default class StreamController extends BaseStreamController {
  private audioCodecSwap: boolean;
  private bitrateTest: boolean;
  private gapController: any;
  private stallReported: boolean;
  private level: number = -1;
  private startFragRequested: boolean = false;
  private forceStartLoad: boolean = false;
  private retryDate: number = 0;
  private levelLastLoaded: number | null = null;
  private altAudio: boolean = false;
  private fragPlaying: Fragment | null = null;
  private previouslyPaused: boolean = false;
  private immediateSwitch: boolean = false;
  private onvseeking: Function | null = null;
  private onvseeked: Function | null = null;
  private onvended: Function | null = null;
  private fragLastKbps: number = 0;
  private stalled: boolean = false;
  private audioCodecSwitch: boolean = false;
  private pendingBuffering: boolean = false;
  private appended: boolean = false;
  private videoBuffer: any | null = null;
  private _liveSyncPosition: number | null = null;

  protected readonly logPrefix = '[stream-controller]';

  constructor (hls, fragmentTracker) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHING,
      Event.MANIFEST_LOADING,
      Event.MANIFEST_PARSED,
      Event.LEVEL_LOADED,
      Event.KEY_LOADED,
      Event.FRAG_LOAD_EMERGENCY_ABORTED,
      Event.ERROR,
      Event.AUDIO_TRACK_SWITCHING,
      Event.AUDIO_TRACK_SWITCHED,
      Event.BUFFER_CREATED,
      Event.BUFFER_APPENDED,
      Event.BUFFER_FLUSHED,
      Event.LEVELS_UPDATED
    );

    this.audioCodecSwap = false;
    this.bitrateTest = false;
    this.fragmentLoader = new FragmentLoader(hls.config);
    this.config = hls.config;
    this.fragmentTracker = fragmentTracker;
    this.gapController = null;
    this.stallReported = false;
    this.state = State.STOPPED;
    this.stallReported = false;
    this.gapController = null;
  }

  startLoad (startPosition): void {
    if (this.levels) {
      const { lastCurrentTime, hls } = this;
      this.stopLoad();
      this.setInterval(TICK_INTERVAL);
      this.level = -1;
      this.fragLoadError = 0;
      if (!this.startFragRequested) {
        // determine load level
        let startLevel = hls.startLevel;
        if (startLevel === -1) {
          if (hls.config.testBandwidth) {
            // -1 : guess start Level by doing a bitrate test by loading first fragment of lowest quality level
            startLevel = 0;
            this.bitrateTest = true;
          } else {
            startLevel = hls.nextAutoLevel;
          }
        }
        // set new level to playlist loader : this will trigger start level load
        // hls.nextLoadLevel remains until it is set to a new value or until a new frag is successfully loaded
        this.level = hls.nextLoadLevel = startLevel;
        this.loadedmetadata = false;
      }
      // if startPosition undefined but lastCurrentTime set, set startPosition to last currentTime
      if (lastCurrentTime > 0 && startPosition === -1) {
        this.log(`Override startPosition with lastCurrentTime @${lastCurrentTime.toFixed(3)}`);
        startPosition = lastCurrentTime;
      }
      this.state = State.IDLE;
      this.nextLoadPosition = this.startPosition = this.lastCurrentTime = startPosition;
      this.tick();
    } else {
      this.forceStartLoad = true;
      this.state = State.STOPPED;
    }
  }

  stopLoad () {
    this.forceStartLoad = false;
    super.stopLoad();
  }

  doTick () {
    switch (this.state) {
    case State.BUFFER_FLUSHING:
      // in buffer flushing state, reset fragLoadError counter
      this.fragLoadError = 0;
      break;
    case State.IDLE:
      this._doTickIdle();
      break;
    case State.WAITING_LEVEL: {
      const { levels, level } = this;
      if (levels && levels[level] && levels[level].details) {
        // Details is set after the playlist has been loaded
        this.state = State.IDLE;
        break;
      }
      break;
    }
    case State.FRAG_LOADING_WAITING_RETRY:
      var now = window.performance.now();
      var retryDate = this.retryDate;
      // if current time is gt than retryDate, or if media seeking let's switch to IDLE state to retry loading
      if (!retryDate || (now >= retryDate) || (this.media && this.media.seeking)) {
        this.log('retryDate reached, switch back to IDLE state');
        this.state = State.IDLE;
      }
      break;
    case State.ERROR:
    case State.STOPPED:
    case State.FRAG_LOADING:
    case State.PARSING:
    case State.PARSED:
    case State.ENDED:
      break;
    default:
      break;
    }
    // check buffer
    this._checkBuffer();
    // check/update current fragment
    this._checkFragmentChanged();
  }

  // Ironically the "idle" state is the on we do the most logic in it seems ....
  // NOTE: Maybe we could rather schedule a check for buffer length after half of the currently
  //       played segment, or on pause/play/seek instead of naively checking every 100ms?
  _doTickIdle () {
    const { hls, levelLastLoaded, levels, media } = this;
    const { config, nextLoadLevel: level } = hls;

    // if start level not parsed yet OR
    // if video not attached AND start fragment already requested OR start frag prefetch disable
    // exit loop, as we either need more info (level not parsed) or we need media to be attached to load new fragment
    if (levelLastLoaded === null || (
      !media && (this.startFragRequested || !config.startFragPrefetch))) {
      return;
    }

    if (!levels || !levels[level]) {
      return;
    }
    const levelInfo = levels[level];

    // if we have not yet loaded any fragment, start loading from start position
    let pos = 0;
    if (this.loadedmetadata) {
      pos = media.currentTime;
    } else if (this.nextLoadPosition) {
      pos = this.nextLoadPosition;
    }

    // compute max Buffer Length that we could get from this load level, based on level bitrate. don't buffer more than 60 MB and more than 30s
    const levelBitrate = levelInfo.bitrate;
    let maxBufLen;
    if (levelBitrate) {
      maxBufLen = Math.max(8 * config.maxBufferSize / levelBitrate, config.maxBufferLength);
    } else {
      maxBufLen = config.maxBufferLength;
    }

    maxBufLen = Math.min(maxBufLen, config.maxMaxBufferLength);

    // determine next candidate fragment to be loaded, based on current position and end of buffer position
    // ensure up to `config.maxMaxBufferLength` of buffer upfront

    const bufferInfo = BufferHelper.bufferInfo(this.mediaBuffer ? this.mediaBuffer : media, pos, config.maxBufferHole);
    let bufferLen = bufferInfo.len;
    // Stay idle if we are still with buffer margins
    if (bufferLen >= maxBufLen) {
      return;
    }

    // if buffer length is less than maxBufLen try to load a new fragment
    // set next load level : this will trigger a playlist load if needed
    this.level = hls.nextLoadLevel = level;

    const levelDetails = levelInfo.details;
    // if level info not retrieved yet, switch state and wait for level retrieval
    // if live playlist, ensure that new playlist has been refreshed to avoid loading/try to load
    // a useless and outdated fragment (that might even introduce load error if it is already out of the live playlist)
    if (!levelDetails || (levelDetails.live && this.levelLastLoaded !== level)) {
      this.state = State.WAITING_LEVEL;
      return;
    }

    if (this._streamEnded(bufferInfo, levelDetails)) {
      const data: any = {};
      if (this.altAudio) {
        data.type = 'video';
      }

      this.hls.trigger(Event.BUFFER_EOS, data);
      this.state = State.ENDED;
      return;
    }
    // if we have the levelDetails for the selected variant, lets continue enrichen our stream (load keys/fragments or trigger EOS, etc..)
    this._fetchPayloadOrEos(pos, bufferInfo, levelDetails);
  }

  _fetchPayloadOrEos (pos, bufferInfo, levelDetails) {
    const fragPrevious = this.fragPrevious,
      level = this.level,
      fragments = levelDetails.fragments,
      fragLen = fragments.length;

    // empty playlist
    if (fragLen === 0) {
      return;
    }

    // find fragment index, contiguous with end of buffer position
    let start = fragments[0].start,
      end = fragments[fragLen - 1].start + fragments[fragLen - 1].duration,
      bufferEnd = bufferInfo.end,
      frag;

    if (levelDetails.initSegment && !levelDetails.initSegment.data) {
      frag = levelDetails.initSegment;
    } else {
      // in case of live playlist we need to ensure that requested position is not located before playlist start
      if (levelDetails.live) {
        let initialLiveManifestSize = this.config.initialLiveManifestSize;
        if (fragLen < initialLiveManifestSize) {
          this.warn(`Can not start playback of a level, reason: not enough fragments ${fragLen} < ${initialLiveManifestSize}`);
          return;
        }

        frag = this._ensureFragmentAtLivePoint(levelDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen);
        // if it explicitely returns null don't load any fragment and exit function now
        if (frag === null) {
          return;
        }
      } else {
        // VoD playlist: if bufferEnd before start of playlist, load first fragment
        if (bufferEnd < start) {
          frag = fragments[0];
        }
      }
    }
    if (!frag) {
      frag = this._findFragment(start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails);
    }

    if (frag) {
      if (frag.encrypted) {
        this.log(`Loading key for ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}],level ${level}`);
        this._loadKey(frag);
      } else {
        this.log(`Loading fragment ${frag.sn} of [${levelDetails.startSN} ,${levelDetails.endSN}],level ${level}, currentTime:${pos.toFixed(3)},bufferEnd:${bufferEnd.toFixed(3)}`);
        this._loadFragment(frag);
      }
    }
  }

  _ensureFragmentAtLivePoint (levelDetails, bufferEnd, start, end, fragPrevious, fragments, fragLen) {
    const config = this.hls.config, media = this.media;

    let frag;

    // check if requested position is within seekable boundaries :
    // this.log(`start/pos/bufEnd/seeking:${start.toFixed(3)}/${pos.toFixed(3)}/${bufferEnd.toFixed(3)}/${this.media.seeking}`);
    let maxLatency = config.liveMaxLatencyDuration !== undefined ? config.liveMaxLatencyDuration : config.liveMaxLatencyDurationCount * levelDetails.targetduration;

    if (bufferEnd < Math.max(start - config.maxFragLookUpTolerance, end - maxLatency)) {
      let liveSyncPosition = this.liveSyncPosition = this.computeLivePosition(start, levelDetails);
      this.log(`Buffer end: ${bufferEnd.toFixed(3)} is located too far from the end of live sliding playlist, reset currentTime to : ${liveSyncPosition.toFixed(3)}`);
      bufferEnd = liveSyncPosition;
      if (media && media.readyState && media.duration > liveSyncPosition) {
        media.currentTime = liveSyncPosition;
      }

      this.nextLoadPosition = liveSyncPosition;
    }

    // if end of buffer greater than live edge, don't load any fragment
    // this could happen if live playlist intermittently slides in the past.
    // level 1 loaded [182580161,182580167]
    // level 1 loaded [182580162,182580169]
    // Loading 182580168 of [182580162 ,182580169],level 1 ..
    // Loading 182580169 of [182580162 ,182580169],level 1 ..
    // level 1 loaded [182580162,182580168] <============= here we should have bufferEnd > end. in that case break to avoid reloading 182580168
    // level 1 loaded [182580164,182580171]
    //
    // don't return null in case media not loaded yet (readystate === 0)
    if (levelDetails.PTSKnown && bufferEnd > end && media && media.readyState) {
      return null;
    }

    if (this.startFragRequested && !levelDetails.PTSKnown) {
      /* we are switching level on live playlist, but we don't have any PTS info for that quality level ...
         try to load frag matching with next SN.
         even if SN are not synchronized between playlists, loading this frag will help us
         compute playlist sliding and find the right one after in case it was not the right consecutive one */
      if (fragPrevious) {
        if (levelDetails.hasProgramDateTime) {
          // Relies on PDT in order to switch bitrates (Support EXT-X-DISCONTINUITY without EXT-X-DISCONTINUITY-SEQUENCE)
          this.log(`Live playlist, switching playlist, load frag with same PDT: ${fragPrevious.programDateTime}`);
          frag = findFragmentByPDT(fragments, fragPrevious.endProgramDateTime, config.maxFragLookUpTolerance);
        } else {
          // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
          const targetSN = fragPrevious.sn + 1;
          if (targetSN >= levelDetails.startSN && targetSN <= levelDetails.endSN) {
            const fragNext = fragments[targetSN - levelDetails.startSN];
            if (fragPrevious.cc === fragNext.cc) {
              frag = fragNext;
              this.log(`Live playlist, switching playlist, load frag with next SN: ${frag.sn}`);
            }
          }
          // next frag SN not available (or not with same continuity counter)
          // look for a frag sharing the same CC
          if (!frag) {
            frag = BinarySearch.search(fragments, function (frag) {
             if (fragPrevious.cc > frag.cc) {
               return 1;
             } else if (fragPrevious < frag.cc) {
               return -1;
             }
             return 0;
            });
            if (frag) {
              this.log(`Live playlist, switching playlist, load frag with same CC: ${frag.sn}`);
            }
          }
        }
      }
      if (!frag) {
        /* we have no idea about which fragment should be loaded.
           so let's load mid fragment. it will help computing playlist sliding and find the right one
        */
        frag = fragments[Math.min(fragLen - 1, Math.round(fragLen / 2))];
        this.log(`Live playlist, switching playlist, unknown, load middle frag : ${frag.sn}`);
      }
    }

    return frag;
  }

  _findFragment (start, fragPrevious, fragLen, fragments, bufferEnd, end, levelDetails) {
    const config = this.hls.config;
    let frag;

    if (bufferEnd < end) {
      const lookupTolerance = (bufferEnd > end - config.maxFragLookUpTolerance) ? 0 : config.maxFragLookUpTolerance;
      // Remove the tolerance if it would put the bufferEnd past the actual end of stream
      // Uses buffer and sequence number to calculate switch segment (required if using EXT-X-DISCONTINUITY-SEQUENCE)
      frag = findFragmentByPTS(fragPrevious, fragments, bufferEnd, lookupTolerance);
    } else {
      // reach end of playlist
      frag = fragments[fragLen - 1];
    }
    if (frag) {
      const curSNIdx = frag.sn - levelDetails.startSN;
      const sameLevel = fragPrevious && frag.level === fragPrevious.level;
      const prevFrag = fragments[curSNIdx - 1];
      const nextFrag = fragments[curSNIdx + 1];
      // this.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
      if (fragPrevious && frag.sn === fragPrevious.sn) {
        if (sameLevel && !frag.backtracked) {
          if (frag.sn < levelDetails.endSN) {
            let deltaPTS = fragPrevious.deltaPTS;
            // if there is a significant delta between audio and video, larger than max allowed hole,
            // and if previous remuxed fragment did not start with a keyframe. (fragPrevious.dropped)
            // let's try to load previous fragment again to get last keyframe
            // then we will reload again current fragment (that way we should be able to fill the buffer hole ...)
            if (deltaPTS && deltaPTS > config.maxBufferHole && fragPrevious.dropped && curSNIdx && !frag.backtracked) {
              frag = prevFrag;
              this.warn('SN just loaded, with large PTS gap between audio and video, maybe frag is not starting with a keyframe ? load previous one to try to overcome this');
            } else {
              frag = nextFrag;
              this.log(`SN just loaded, load next one: ${frag.sn}`);
            }
          } else {
            frag = null;
          }
        } else if (frag.backtracked) {
          // Only backtrack a max of 1 consecutive fragment to prevent sliding back too far when little or no frags start with keyframes
          if (nextFrag && nextFrag.backtracked) {
            this.warn(`Already backtracked from fragment ${nextFrag.sn}, will not backtrack to fragment ${frag.sn}. Loading fragment ${nextFrag.sn}`);
            frag = nextFrag;
          } else {
            // If a fragment has dropped frames and it's in a same level/sequence, load the previous fragment to try and find the keyframe
            // Reset the dropped count now since it won't be reset until we parse the fragment again, which prevents infinite backtracking on the same segment
            this.warn('Loaded fragment with dropped frames, backtracking 1 segment to find a keyframe');
            frag.dropped = 0;
            if (prevFrag) {
              frag = prevFrag;
              frag.backtracked = true;
            } else if (curSNIdx) {
              // can't backtrack on very first fragment
              frag = null;
            }
          }
        }
      }
    }
    return frag;
  }

  _loadKey (frag) {
    this.state = State.KEY_LOADING;
    this.hls.trigger(Event.KEY_LOADING, { frag });
  }

  _loadFragment (frag) {
    // Check if fragment is not loaded
    let fragState = this.fragmentTracker.getState(frag);

    this.fragCurrent = frag;
    this.startFragRequested = true;
    // Don't update nextLoadPosition for fragments which are not buffered
    if (Number.isFinite(frag.sn) && !this.bitrateTest) {
      this.nextLoadPosition = frag.start + frag.duration;
    }

    // Allow backtracked fragments to load
    if (frag.backtracked || fragState === FragmentState.NOT_LOADED || fragState === FragmentState.PARTIAL) {
      frag.autoLevel = this.hls.autoLevelEnabled;

      if (frag.sn === 'initSegment') {
        this._loadInitSegment(frag);
      } else if (this.bitrateTest) {
        frag.bitrateTest = true;
        this.log(`Fragment ${frag.sn} of level ${frag.level} is being downloaded to test bitrate and will not be buffered`);
        this._loadBitrateTestFrag(frag);
      } else {
        this._loadFragForPlayback(frag);
      }
    } else if (fragState === FragmentState.APPENDING) {
      // Lower the buffer size and try again
      if (this._reduceMaxBufferLength(frag.duration)) {
        this.fragmentTracker.removeFragment(frag);
      }
    }
  }

  getBufferedFrag (position) {
    return this.fragmentTracker.getBufferedFrag(position, PlaylistLoader.LevelType.MAIN);
  }

  get currentLevel () {
    let media = this.media;
    if (media) {
      const frag = this.getBufferedFrag(media.currentTime);
      if (frag) {
        return frag.level;
      }
    }
    return -1;
  }

  get nextBufferedFrag () {
    let media = this.media;
    if (media) {
      // first get end range of current fragment
      return this.followingBufferedFrag(this.getBufferedFrag(media.currentTime));
    } else {
      return null;
    }
  }

  followingBufferedFrag (frag) {
    if (frag) {
      // try to get range of next fragment (500ms after this range)
      return this.getBufferedFrag(frag.endPTS + 0.5);
    }
    return null;
  }

  get nextLevel () {
    const frag = this.nextBufferedFrag;
    if (frag) {
      return frag.level;
    } else {
      return -1;
    }
  }

  _checkFragmentChanged () {
    let fragPlayingCurrent, currentTime, video = this.media;
    if (video && video.readyState && video.seeking === false) {
      currentTime = video.currentTime;
      /* if video element is in seeked state, currentTime can only increase.
        (assuming that playback rate is positive ...)
        As sometimes currentTime jumps back to zero after a
        media decode error, check this, to avoid seeking back to
        wrong position after a media decode error
      */
      if (currentTime > this.lastCurrentTime) {
        this.lastCurrentTime = currentTime;
      }

      if (BufferHelper.isBuffered(video, currentTime)) {
        fragPlayingCurrent = this.getBufferedFrag(currentTime);
      } else if (BufferHelper.isBuffered(video, currentTime + 0.1)) {
        /* ensure that FRAG_CHANGED event is triggered at startup,
          when first video frame is displayed and playback is paused.
          add a tolerance of 100ms, in case current position is not buffered,
          check if current pos+100ms is buffered and use that buffer range
          for FRAG_CHANGED event reporting */
        fragPlayingCurrent = this.getBufferedFrag(currentTime + 0.1);
      }
      if (fragPlayingCurrent) {
        let fragPlaying = fragPlayingCurrent;
        if (fragPlaying !== this.fragPlaying) {
          this.hls.trigger(Event.FRAG_CHANGED, { frag: fragPlaying });
          const fragPlayingLevel = fragPlaying.level;
          if (!this.fragPlaying || this.fragPlaying.level !== fragPlayingLevel) {
            this.hls.trigger(Event.LEVEL_SWITCHED, { level: fragPlayingLevel });
          }

          this.fragPlaying = fragPlaying;
        }
      }
    }
  }

  /*
    on immediate level switch :
     - pause playback if playing
     - cancel any pending load request
     - and trigger a buffer flush
  */
  immediateLevelSwitch () {
    this.log('immediateLevelSwitch');
    if (!this.immediateSwitch) {
      this.immediateSwitch = true;
      let media = this.media, previouslyPaused;
      if (media) {
        previouslyPaused = media.paused;
        media.pause();
      } else {
        // don't restart playback after instant level switch in case media not attached
        previouslyPaused = true;
      }
      this.previouslyPaused = previouslyPaused;
    }
    let fragCurrent = this.fragCurrent;
    if (fragCurrent && fragCurrent.loader) {
      fragCurrent.loader.abort();
    }

    this.fragCurrent = null;
    // flush everything
    this.flushMainBuffer(0, Number.POSITIVE_INFINITY);
  }

  /**
   * on immediate level switch end, after new fragment has been buffered:
   * - nudge video decoder by slightly adjusting video currentTime (if currentTime buffered)
   * - resume the playback if needed
   */
  immediateLevelSwitchEnd () {
    const media = this.media;
    if (media && media.buffered.length) {
      this.immediateSwitch = false;
      if (BufferHelper.isBuffered(media, media.currentTime)) {
        // only nudge if currentTime is buffered
        media.currentTime -= 0.0001;
      }
      if (!this.previouslyPaused) {
        media.play();
      }
    }
  }

  /**
   * try to switch ASAP without breaking video playback:
   * in order to ensure smooth but quick level switching,
   * we need to find the next flushable buffer range
   * we should take into account new segment fetch time
   */
  nextLevelSwitch () {
    const { levels, media } = this;
    // ensure that media is defined and that metadata are available (to retrieve currentTime)
    if (media && media.readyState) {
      let fetchdelay, fragPlayingCurrent, nextBufferedFrag;
      fragPlayingCurrent = this.getBufferedFrag(media.currentTime);
      if (fragPlayingCurrent && fragPlayingCurrent.startPTS > 1) {
        // flush buffer preceding current fragment (flush until current fragment start offset)
        // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
        this.flushMainBuffer(0, fragPlayingCurrent.startPTS - 1);
      }
      if (!media.paused && levels) {
        // add a safety delay of 1s
        let nextLevelId = this.hls.nextLoadLevel, nextLevel = levels[nextLevelId], fragLastKbps = this.fragLastKbps;
        if (fragLastKbps && this.fragCurrent) {
          fetchdelay = this.fragCurrent.duration * nextLevel.bitrate / (1000 * fragLastKbps) + 1;
        } else {
          fetchdelay = 0;
        }
      } else {
        fetchdelay = 0;
      }
      // this.log('fetchdelay:'+fetchdelay);
      // find buffer range that will be reached once new fragment will be fetched
      nextBufferedFrag = this.getBufferedFrag(media.currentTime + fetchdelay);
      if (nextBufferedFrag) {
        // we can flush buffer range following this one without stalling playback
        nextBufferedFrag = this.followingBufferedFrag(nextBufferedFrag);
        if (nextBufferedFrag) {
          // if we are here, we can also cancel any loading/demuxing in progress, as they are useless
          let fragCurrent = this.fragCurrent;
          if (fragCurrent && fragCurrent.loader) {
            fragCurrent.loader.abort();
          }

          this.fragCurrent = null;
          // start flush position is the start PTS of next buffered frag.
          // we use frag.naxStartPTS which is max(audio startPTS, video startPTS).
          // in case there is a small PTS Delta between audio and video, using maxStartPTS avoids flushing last samples from current fragment
          this.flushMainBuffer(nextBufferedFrag.maxStartPTS, Number.POSITIVE_INFINITY);
        }
      }
    }
  }

  flushMainBuffer (startOffset, endOffset) {
    this.state = State.BUFFER_FLUSHING;
    let flushScope: any = { startOffset: startOffset, endOffset: endOffset };
    // if alternate audio tracks are used, only flush video, otherwise flush everything
    if (this.altAudio) {
      flushScope.type = 'video';
    }

    this.hls.trigger(Event.BUFFER_FLUSHING, flushScope);
  }

  onMediaAttached (data) {
    let media = this.media = this.mediaBuffer = data.media;
    this.onvseeking = this.onMediaSeeking.bind(this);
    this.onvseeked = this.onMediaSeeked.bind(this);
    this.onvended = this.onMediaEnded.bind(this);
    media.addEventListener('seeking', this.onvseeking);
    media.addEventListener('seeked', this.onvseeked);
    media.addEventListener('ended', this.onvended);
    let config = this.config;
    if (this.levels && config.autoStartLoad) {
      this.hls.startLoad(config.startPosition);
    }

    this.gapController = new GapController(config, media, this.fragmentTracker, this.hls);
  }

  onMediaDetaching () {
    const { levels, media } = this;
    if (media && media.ended) {
      this.log('MSE detaching and video ended, reset startPosition');
      this.startPosition = this.lastCurrentTime = 0;
    }

    // reset fragment backtracked flag
    if (levels) {
      levels.forEach(level => {
        if (level.details) {
          level.details.fragments.forEach(fragment => {
            fragment.backtracked = undefined;
          });
        }
      });
    }
    // remove video listeners
    if (media) {
      media.removeEventListener('seeking', this.onvseeking);
      media.removeEventListener('seeked', this.onvseeked);
      media.removeEventListener('ended', this.onvended);
      this.onvseeking = this.onvseeked = this.onvended = null
    }
    this.media = this.mediaBuffer = null;
    this.loadedmetadata = false;
    this.stopLoad();
  }

  onMediaSeeked () {
    const media = this.media, currentTime = media ? media.currentTime : undefined;
    if (Number.isFinite(currentTime)) {
      this.log(`Media seeked to ${currentTime.toFixed(3)}`);
    }

    // tick to speed up FRAGMENT_PLAYING triggering
    this.tick();
  }

  onManifestLoading () {
    // reset buffer on manifest loading
    this.log('Trigger BUFFER_RESET');
    this.hls.trigger(Event.BUFFER_RESET);
    this.fragmentTracker.removeAllFragments();
    this.stalled = false;
    this.startPosition = this.lastCurrentTime = 0;
    this.fragPlaying = null;
  }

  onManifestParsed (data) {
    let aac = false, heaac = false, codec;
    data.levels.forEach(level => {
      // detect if we have different kind of audio codecs used amongst playlists
      codec = level.audioCodec;
      if (codec) {
        if (codec.indexOf('mp4a.40.2') !== -1) {
          aac = true;
        }

        if (codec.indexOf('mp4a.40.5') !== -1) {
          heaac = true;
        }
      }
    });
    this.audioCodecSwitch = (aac && heaac);
    if (this.audioCodecSwitch) {
      this.log('Both AAC/HE-AAC audio found in levels; declaring level codec as HE-AAC');
    }

    this.levels = data.levels;
    this.startFragRequested = false;
    let config = this.config;
    if (config.autoStartLoad || this.forceStartLoad) {
      this.hls.startLoad(config.startPosition);
    }
  }

  onLevelLoaded (data) {
    const { levels, levelLastLoaded } = this;
    const newLevelId = data.level;
    const newDetails = data.details;
    const duration = newDetails.totalduration;

    if (!levels) {
      this.warn(`Levels were reset while loading level ${newLevelId}`);
      return;
    }
    this.log(`Level ${newLevelId} loaded [${newDetails.startSN},${newDetails.endSN}], cc [${newDetails.startCC}, ${newDetails.endCC}] duration:${duration}`);


    let lastLevel;
    let curLevel = levels[newLevelId];
    if (levelLastLoaded) {
      lastLevel = levels[levelLastLoaded];
    }

    let sliding = 0;
    if (newDetails.live) {
      let curDetails = curLevel.details;
      if (curDetails && newDetails.fragments.length > 0) {
        // we already have details for that level, merge them
        LevelHelper.mergeDetails(curDetails, newDetails);
        sliding = newDetails.fragments[0].start;
        this.liveSyncPosition = this.computeLivePosition(sliding, curDetails);
        if (newDetails.PTSKnown && Number.isFinite(sliding)) {
          this.log(`Live playlist sliding:${sliding.toFixed(3)}`);
        } else {
          this.log('Live playlist - outdated PTS, unknown sliding');
          alignStream(this.fragPrevious, lastLevel, newDetails);
        }
      } else {
        this.log('Live playlist - first load, unknown sliding');
        newDetails.PTSKnown = false;
        alignStream(this.fragPrevious, lastLevel, newDetails);
      }
    } else {
      newDetails.PTSKnown = false;
    }
    // override level info
    curLevel.details = newDetails;
    this.levelLastLoaded = newLevelId;
    this.hls.trigger(Event.LEVEL_UPDATED, { details: newDetails, level: newLevelId });

    if (!this.startFragRequested) {
    // compute start position if set to -1. use it straight away if value is defined
      if (this.startPosition === -1 || this.lastCurrentTime === -1) {
        // first, check if start time offset has been set in playlist, if yes, use this value
        let startTimeOffset = newDetails.startTimeOffset;
        if (Number.isFinite(startTimeOffset)) {
          if (startTimeOffset < 0) {
            this.log(`Negative start time offset ${startTimeOffset}, count from end of last fragment`);
            startTimeOffset = sliding + duration + startTimeOffset;
          }
          this.log(`Start time offset found in playlist, adjust startPosition to ${startTimeOffset}`);
          this.startPosition = startTimeOffset;
        } else {
          // if live playlist, set start position to be fragment N-this.config.liveSyncDurationCount (usually 3)
          if (newDetails.live) {
            this.startPosition = this.computeLivePosition(sliding, newDetails);
            this.log(`Configure startPosition to ${this.startPosition}`);
          } else {
            this.startPosition = 0;
          }
        }
        this.lastCurrentTime = this.startPosition;
      }
      this.nextLoadPosition = this.startPosition;
    }
    // only switch batck to IDLE state if we were waiting for level to start downloading a new fragment
    if (this.state === State.WAITING_LEVEL) {
      this.state = State.IDLE;
    }

    // trigger handler right now
    this.tick();
  }

  onKeyLoaded () {
    if (this.state === State.KEY_LOADING) {
      this.state = State.IDLE;
      this.tick();
    }
  }

  _handleFragmentLoadProgress (frag, payload) {
    const { levels, media } = this;
    if (!levels) {
      this.warn(`Levels were reset while fragment load was in progress. Fragment ${frag.sn} of level ${frag.level} will not be buffered`);
      return;
    }
    const currentLevel = levels[frag.level];
    const details = currentLevel.details;

    // time Offset is accurate if level PTS is known, or if playlist is not sliding (not live) and if media is not seeking (this is to overcome potential timestamp drifts between playlists and fragments)
    const accurateTimeOffset = !(media && media.seeking) && (details.PTSKnown || !details.live);
    const initSegmentData = details.initSegment ? details.initSegment.data : [];
    const audioCodec = this._getAudioCodec(currentLevel);

    // transmux the MPEG-TS data to ISO-BMFF segments
    // this.log(`Transmuxing ${frag.sn} of [${details.startSN} ,${details.endSN}],level ${frag.level}, cc ${frag.cc}`);
    const transmuxer = this.transmuxer = this.transmuxer ||
          new TransmuxerInterface(this.hls, 'main', this._handleTransmuxComplete.bind(this), this._handleTransmuxerFlush.bind(this));
    const transmuxIdentifier = { level: frag.level, sn: frag.sn };
    transmuxer.push(
      payload,
      initSegmentData,
      audioCodec,
      currentLevel.videoCodec,
      frag,
      details.totalduration,
      accurateTimeOffset,
      null,
      transmuxIdentifier
    );
  }

  onAudioTrackSwitching (data) {
    // if any URL found on new audio track, it is an alternate audio track
    let altAudio = !!data.url,
      trackId = data.id;
    // if we switch on main audio, ensure that main fragment scheduling is synced with media.buffered
    // don't do anything if we switch to alt audio: audio stream controller is handling it.
    // we will just have to change buffer scheduling on audioTrackSwitched
    if (!altAudio) {
      if (this.mediaBuffer !== this.media) {
        this.log('Switching on main audio, use media.buffered to schedule main fragment loading');
        this.mediaBuffer = this.media;
        let fragCurrent = this.fragCurrent;
        // we need to refill audio buffer from main: cancel any frag loading to speed up audio switch
        if (fragCurrent && fragCurrent.loader) {
          this.log('Switching to main audio track, cancel main fragment load');
          fragCurrent.loader.abort();
        }
        this.fragCurrent = null;
        this.fragPrevious = null;
        // destroy transmuxer to force init segment generation (following audio switch)
        if (this.transmuxer) {
          this.transmuxer.destroy();
          this.transmuxer = null;
        }
        // switch to IDLE state to load new fragment
        this.state = State.IDLE;
      }
      let hls = this.hls;
      // switching to main audio, flush all audio and trigger track switched
      hls.trigger(Event.BUFFER_FLUSHING, { startOffset: 0, endOffset: Number.POSITIVE_INFINITY, type: 'audio' });
      hls.trigger(Event.AUDIO_TRACK_SWITCHED, { id: trackId });
      this.altAudio = false;
    }
  }

  onAudioTrackSwitched (data) {
    let trackId = data.id,
      altAudio = !!this.hls.audioTracks[trackId].url;
    if (altAudio) {
      let videoBuffer = this.videoBuffer;
      // if we switched on alternate audio, ensure that main fragment scheduling is synced with video sourcebuffer buffered
      if (videoBuffer && this.mediaBuffer !== videoBuffer) {
        this.log('Switching on alternate audio, use video.buffered to schedule main fragment loading');
        this.mediaBuffer = videoBuffer;
      }
    }
    this.altAudio = altAudio;
    this.tick();
  }

  onBufferCreated (data) {
    let tracks = data.tracks, mediaTrack, name, alternate = false;
    for (let type in tracks) {
      let track = tracks[type];
      if (track.id === 'main') {
        name = type;
        mediaTrack = track;
        // keep video source buffer reference
        if (type === 'video') {
          this.videoBuffer = tracks[type].buffer;
        }
      } else {
        alternate = true;
      }
    }
    if (alternate && mediaTrack) {
      this.log(`Alternate track found, use ${name}.buffered to schedule main fragment loading`);
      this.mediaBuffer = mediaTrack.buffer;
    } else {
      this.mediaBuffer = this.media;
    }
  }

  onBufferAppended (data) {
    if (data.parent === 'main') {
      const state = this.state;
      if (state === State.PARSING || state === State.PARSED) {
        // check if all buffers have been appended
        this.pendingBuffering = (data.pending > 0);
        this._checkAppendedParsed();
      }
    }
  }

  _checkAppendedParsed () {
    // trigger handler right now
    if (this.state === State.PARSED && (!this.appended || !this.pendingBuffering)) {
      const frag = this.fragCurrent;
      if (frag) {
        const media = this.mediaBuffer ? this.mediaBuffer : this.media;
        this.fragPrevious = frag;

        this.log(`Parsed fragment ${frag.sn} of level ${frag.level}, PTS:[${frag.startPTS},${frag.endPTS}],DTS:[${frag.startDTS}/${frag.endDTS}]`);
        this.log(`Buffered : ${TimeRanges.toString(media.buffered)}`);

        const stats = frag.stats;
        stats.tbuffered = window.performance.now();
        // TODO: Remove fragLastKbps
        this.fragLastKbps = Math.round(8 * stats.total / (stats.tbuffered - stats.tfirst));
        this.hls.trigger(Event.FRAG_BUFFERED, { stats, frag: frag, id: 'main' });
        this.state = State.IDLE;
      }
      this.tick();
    }
  }

  onError (data) {
    let frag = data.frag || this.fragCurrent;
    // don't handle frag error not related to main fragment
    if (frag && frag.type !== 'main') {
      return;
    }

    // 0.5 : tolerance needed as some browsers stalls playback before reaching buffered end
    let mediaBuffered = !!this.media && BufferHelper.isBuffered(this.media, this.media.currentTime) && BufferHelper.isBuffered(this.media, this.media.currentTime + 0.5);

    switch (data.details) {
    case ErrorDetails.FRAG_LOAD_ERROR:
    case ErrorDetails.FRAG_LOAD_TIMEOUT:
    case ErrorDetails.KEY_LOAD_ERROR:
    case ErrorDetails.KEY_LOAD_TIMEOUT:
      if (!data.fatal) {
        // keep retrying until the limit will be reached
        if ((this.fragLoadError + 1) <= this.config.fragLoadingMaxRetry) {
          // exponential backoff capped to config.fragLoadingMaxRetryTimeout
          let delay = Math.min(Math.pow(2, this.fragLoadError) * this.config.fragLoadingRetryDelay, this.config.fragLoadingMaxRetryTimeout);
          this.warn(`Fragment ${frag.sn} of level ${frag.level} failed to load, retrying in ${delay}ms`);
          this.retryDate = window.performance.now() + delay;
          // retry loading state
          // if loadedmetadata is not set, it means that we are emergency switch down on first frag
          // in that case, reset startFragRequested flag
          if (!this.loadedmetadata) {
            this.startFragRequested = false;
            this.nextLoadPosition = this.startPosition;
          }
          this.fragLoadError++;
          this.state = State.FRAG_LOADING_WAITING_RETRY;
        } else {
          logger.error(`mediaController: ${data.details} reaches max retry, redispatch as fatal ...`);
          // switch error to fatal
          data.fatal = true;
          this.state = State.ERROR;
        }
      }
      break;
    case ErrorDetails.LEVEL_LOAD_ERROR:
    case ErrorDetails.LEVEL_LOAD_TIMEOUT:
      if (this.state !== State.ERROR) {
        if (data.fatal) {
          // if fatal error, stop processing
          this.warn(`${data.details}`);
          this.state = State.ERROR;
        } else {
          // in case of non fatal error while loading level, if level controller is not retrying to load level , switch back to IDLE
          if (!data.levelRetry && this.state === State.WAITING_LEVEL) {
            this.state = State.IDLE;
          }
        }
      }
      break;
    case ErrorDetails.BUFFER_FULL_ERROR:
      // if in appending state
      if (data.parent === 'main' && (this.state === State.PARSING || this.state === State.PARSED)) {
        // reduce max buf len if current position is buffered
        if (mediaBuffered) {
          this._reduceMaxBufferLength(this.config.maxBufferLength);
          this.state = State.IDLE;
        } else {
          // current position is not buffered, but browser is still complaining about buffer full error
          // this happens on IE/Edge, refer to https://github.com/video-dev/hls.js/pull/708
          // in that case flush the whole buffer to recover
          this.warn('buffer full error also media.currentTime is not buffered, flush everything');
          this.fragCurrent = null;
          // flush everything
          this.flushMainBuffer(0, Number.POSITIVE_INFINITY);
        }
      }
      break;
    default:
      break;
    }
  }

  _reduceMaxBufferLength (minLength) {
    let config = this.config;
    if (config.maxMaxBufferLength >= minLength) {
      // reduce max buffer length as it might be too high. we do this to avoid loop flushing ...
      config.maxMaxBufferLength /= 2;
      this.warn(`Reduce max buffer length to ${config.maxMaxBufferLength}s`);
      return true;
    }
    return false;
  }

  /**
   * Checks the health of the buffer and attempts to resolve playback stalls.
   * @private
   */
  _checkBuffer () {
    const { media } = this;
    if (!media || media.readyState === 0) {
      // Exit early if we don't have media or if the media hasn't bufferd anything yet (readyState 0)
      return;
    }

    const mediaBuffer = this.mediaBuffer ? this.mediaBuffer : media;
    const buffered = mediaBuffer.buffered;

    if (!this.loadedmetadata && buffered.length) {
      this.loadedmetadata = true;
      this._seekToStartPos();
    } else if (this.immediateSwitch) {
      this.immediateLevelSwitchEnd();
    } else {
      this.gapController.poll(this.lastCurrentTime, buffered);
    }
  }

  onFragLoadEmergencyAborted () {
    this.state = State.IDLE;
    // if loadedmetadata is not set, it means that we are emergency switch down on first frag
    // in that case, reset startFragRequested flag
    if (!this.loadedmetadata) {
      this.startFragRequested = false;
      this.nextLoadPosition = this.startPosition;
    }
    this.tick();
  }

  onBufferFlushed () {
    /* after successful buffer flushing, filter flushed fragments from bufferedFrags
      use mediaBuffered instead of media (so that we will check against video.buffered ranges in case of alt audio track)
    */
    const media = this.mediaBuffer ? this.mediaBuffer : this.media;
    if (media) {
      // filter fragments potentially evicted from buffer. this is to avoid memleak on live streams
      this.fragmentTracker.detectEvictedFragments(ElementaryStreamTypes.VIDEO, media.buffered);
    }
    // move to IDLE once flush complete. this should trigger new fragment loading
    this.state = State.IDLE;
    // reset reference to frag
    this.fragPrevious = null;
  }

  onLevelsUpdated (data) {
    this.levels = data.levels;
  }

  swapAudioCodec () {
    this.audioCodecSwap = !this.audioCodecSwap;
  }

  computeLivePosition (sliding, levelDetails) {
    let targetLatency = this.config.liveSyncDuration !== undefined ? this.config.liveSyncDuration : this.config.liveSyncDurationCount * levelDetails.targetduration;
    return sliding + Math.max(0, levelDetails.totalduration - targetLatency);
  }

  /**
   * Seeks to the set startPosition if not equal to the mediaElement's current time.
   * @private
   */
  _seekToStartPos () {
    const { media } = this;
    const currentTime = media.currentTime;
    // only adjust currentTime if different from startPosition or if startPosition not buffered
    // at that stage, there should be only one buffered range, as we reach that code after first fragment has been buffered
    const startPosition = media.seeking ? currentTime : this.startPosition;
    // if currentTime not matching with expected startPosition or startPosition not buffered but close to first buffered
    if (currentTime !== startPosition) {
      // if startPosition not buffered, let's seek to buffered.start(0)
      this.log(`Target start position not buffered, seek to buffered.start(0) ${startPosition} from current time ${currentTime} `);
      media.currentTime = startPosition;
    }
  }

  _getAudioCodec (currentLevel) {
    let audioCodec = this.config.defaultAudioCodec || currentLevel.audioCodec;
    if (this.audioCodecSwap) {
      this.log('Swapping playlist audio codec');
      if (audioCodec) {
        if (audioCodec.indexOf('mp4a.40.5') !== -1) {
          audioCodec = 'mp4a.40.2';
        } else {
          audioCodec = 'mp4a.40.5';
        }
      }
    }

    return audioCodec;
  }

  private _loadBitrateTestFrag (frag) {
    this._doFragLoad(frag)
      .then((data) => {
        const { hls } = this;
        if (!data || hls.nextLoadLevel || this._fragLoadAborted(frag)) {
          return;
        }
        this.fragLoadError = 0;
        this.state = State.IDLE;
        this.startFragRequested = false;
        this.bitrateTest = false;
        frag.bitrateTest = false;
        const stats = frag.stats;
        stats.tparsed = stats.tbuffered = window.performance.now();
        hls.trigger(Event.FRAG_BUFFERED, { stats: stats, frag, id: 'main' });
        this.tick();
      });
  }

  private _handleTransmuxComplete (transmuxResult) {
    const id = 'main';
    const { hls } = this;
    const { remuxResult, transmuxIdentifier } = transmuxResult;

    const context = this.getCurrentContext(transmuxIdentifier);
    if (!context) {
      this.warn(`The loading context changed while buffering fragment ${transmuxIdentifier.sn} of level ${transmuxIdentifier.level}. This chunk will not be buffered.`);
      return;
    }
    const { frag, level } = context;

    let { audio, video, text, id3, initSegment } = remuxResult;
    // The audio-stream-controller handles audio buffering if Hls.js is playing an alternate audio track
    if (this.altAudio) {
      audio = null;
    }

    // Update timing before a potential backtrack
    this._updateTiming(frag, level, audio);
    this._updateTiming(frag, level, video);

    this.state = State.PARSING;
    this.pendingBuffering = true;
    this.appended = false;

    if (initSegment) {
      if (initSegment.tracks) {
        this._bufferInitSegment(level,initSegment.tracks);
        hls.trigger(Event.FRAG_PARSING_INIT_SEGMENT, { frag, id, tracks: initSegment.tracks });
      }
      if (Number.isFinite(initSegment.initPTS)) {
        hls.trigger(Event.INIT_PTS_FOUND, { frag, id, initPTS: initSegment.initPTS });
      }
    }

    // Avoid buffering if backtracking this fragment
    if (video) {
      if (_hasDroppedFrames(frag, video.dropped, level.details.startSN)) {
        this._backtrack(frag, video.startPTS);
        return;
      } else {
        this._bufferFragmentData(video);
      }
    }

    this._bufferFragmentData(audio);

    if (id3) {
      id3.frag = frag;
      id3.id = id;
      hls.trigger(Event.FRAG_PARSING_METADATA, id3);
    }
    if (text) {
      text.frag = frag;
      text.id = id;
      hls.trigger(Event.FRAG_PARSING_USERDATA, text);
    }
  }

  private _bufferInitSegment (currentLevel, tracks) {
    if (this.state !== State.PARSING) {
      return;
    }
    // if audio track is expected to come from audio stream controller, discard any coming from main
    if (tracks.audio && this.altAudio) {
      delete tracks.audio;
    }
    // include levelCodec in audio and video tracks
    const { audio, video } = tracks;
    if (audio) {
      let audioCodec = currentLevel.audioCodec;
      const ua = navigator.userAgent.toLowerCase();
      if (audioCodec && this.audioCodecSwap) {
        this.log('Swapping playlist audio codec');
        if (audioCodec.indexOf('mp4a.40.5') !== -1) {
          audioCodec = 'mp4a.40.2';
        } else {
          audioCodec = 'mp4a.40.5';
        }
      }
      // In the case that AAC and HE-AAC audio codecs are signalled in manifest,
      // force HE-AAC, as it seems that most browsers prefers it.
      if (this.audioCodecSwitch) {
        // don't force HE-AAC if mono stream, or in Firefox
        if (audio.metadata.channelCount !== 1 && ua.indexOf('firefox') === -1) {
          audioCodec = 'mp4a.40.5';
        }
      }
      // HE-AAC is broken on Android, always signal audio codec as AAC even if variant manifest states otherwise
      if (ua.indexOf('android') !== -1 && audio.container !== 'audio/mpeg') { // Exclude mpeg audio
        audioCodec = 'mp4a.40.2';
        this.log(`Android: force audio codec to ${audioCodec}`);
      }
      audio.levelCodec = audioCodec;
      audio.id = 'main';
    }
    if (video) {
      video.levelCodec = currentLevel.videoCodec;
      video.id = 'main';
    }
    this.hls.trigger(Event.BUFFER_CODECS, tracks);
    // loop through tracks that are going to be provided to bufferController
    Object.keys(tracks).forEach(trackName => {
      const track = tracks[trackName];
      const initSegment = track.initSegment;
      this.log(`Main track:${trackName},container:${track.container},codecs[level/parsed]=[${track.levelCodec}/${track.codec}]`);
      if (initSegment) {
        this.appended = true;
        // arm pending Buffering flag before appending a segment
        this.pendingBuffering = true;
        this.hls.trigger(Event.BUFFER_APPENDING, { type: trackName, data: initSegment, parent: 'main', content: 'initSegment' });
      }
    });
    // trigger handler right now
    this.tick();
  }

  private _bufferFragmentData (data) {
    if (!data || this.state !== State.PARSING) {
      return;
    }
    // has remuxer dropped video frames located before first keyframe ?
    [data.data1, data.data2].forEach(buffer => {
      // only append in PARSING state (rationale is that an appending error could happen synchronously on first segment appending)
      // in that case it is useless to append following segments
      if (buffer && buffer.length && this.state === State.PARSING) {
        this.appended = true;
        // arm pending Buffering flag before appending a segment
        this.pendingBuffering = true;
        this.hls.trigger(Event.BUFFER_APPENDING, { type: data.type, data: buffer, parent: 'main', content: 'data' });
      }
    });
    // trigger handler right now
    this.tick();
  }

  private _updateTiming (frag, currentLevel, data) {
    if (!data) {
      return;
    }

    if (!Number.isFinite(data.endPTS)) {
      data.endPTS = data.startPTS + frag.duration;
      data.endDTS = data.startDTS + frag.duration;
    }

    if (data.hasAudio === true) {
      frag.addElementaryStream(ElementaryStreamTypes.AUDIO);
    }

    if (data.hasVideo === true) {
      frag.addElementaryStream(ElementaryStreamTypes.VIDEO);
    }
    // this.log(`Parsed ${data.type},PTS:[${data.startPTS.toFixed(3)},${data.endPTS.toFixed(3)}],DTS:[${data.startDTS.toFixed(3)}/${data.endDTS.toFixed(3)}],nb:${data.nb},dropped:${data.dropped || 0}`);

    const { details } = currentLevel;
    const drift = LevelHelper.updateFragPTSDTS(details, frag, data.startPTS, data.endPTS, data.startDTS, data.endDTS);
    this.hls.trigger(Event.LEVEL_PTS_UPDATED, { details, level: currentLevel, drift, type: data.type, start: data.startPTS, end: data.endPTS });
  }

  private _backtrack (frag, nextLoadPosition) {
    // Return back to the IDLE state without appending to buffer
    // Causes findFragments to backtrack a segment and find the keyframe
    // Audio fragments arriving before video sets the nextLoadPosition, causing _findFragments to skip the backtracked fragment
    this.fragmentTracker.removeFragment(frag);
    frag.backtracked = true;
    this.nextLoadPosition = nextLoadPosition;
    this.state = State.IDLE;
    this.fragPrevious = frag;
    this.tick();
  }

  get liveSyncPosition () {
    return this._liveSyncPosition;
  }

  set liveSyncPosition (value) {
    this._liveSyncPosition = value;
  }
}

function _hasDroppedFrames (frag, dropped, startSN) {
  // Detect gaps in a fragment  and try to fix it by finding a keyframe in the previous fragment (see _findFragments)
  if (dropped) {
    frag.dropped = dropped;
    if (!frag.backtracked) {
      if (frag.sn === startSN) {
        logger.warn(`[stream-controller]:  Fragment ${frag.sn} of level ${frag.level} is missing ${frag.dropped} video frame(s); this is the start fragment and will be appended with a gap`);
        return false;
      } else {
        logger.warn(`[stream-controller]: Fragment ${frag.sn} of level ${frag.level} is missing ${frag.dropped} video frame(s); backtracking to find a keyframe`);
        return true;
      }
    } else {
      logger.warn(`[stream-controller]: Fragment ${frag.sn} of level ${frag.level} already backtracked and will be appended with a gap`);
      frag.backtracked = false;
      return false;
    }
  } else {
    // Only reset the backtracked flag if we've loaded the frag without any dropped frames
    frag.backtracked = false;
    return false;
  }
}