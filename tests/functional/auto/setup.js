/* eslint-disable no-console */

const sauceConnectLauncher = require('sauce-connect-launcher');
const webdriver = require('selenium-webdriver');
const By = webdriver.By;
const until = webdriver.until;
// requiring this automatically adds the chromedriver binary to the PATH
require('chromedriver');
const HttpServer = require('http-server');
const streams = require('../../test-streams');
const onTravis = !!process.env.TRAVIS;
const useSauce = !!process.env.SAUCE || onTravis;
const chai = require('chai');
const expect = chai.expect;

const browserConfig = {
  version: 'latest',
  name: 'chrome'
};

/**
 * @type {webdriver.ThenableWebDriver}
 */
let browser;
let stream;
let printDebugLogs = false;

// Setup browser config data from env vars
if (useSauce) {
  let UA = process.env.UA;
  if (!UA) {
    throw new Error('No test browser name.');
  }

  let OS = process.env.OS;
  if (!OS) {
    throw new Error('No test browser platform.');
  }

  let UA_VERSION = process.env.UA_VERSION;
  if (UA_VERSION) {
    browserConfig.version = UA_VERSION;
  }

  browserConfig.name = UA;
  browserConfig.platform = OS;
}

let browserDescription = browserConfig.name;

if (browserConfig.version && browserConfig.version !== 'latest') {
  browserDescription += ` ${browserConfig.version}`;
}

if (browserConfig.platform) {
  browserDescription += `, ${browserConfig.platform}`;
}

let hostname = useSauce ? 'localhost' : '127.0.0.1';

// Launch static server
HttpServer.createServer({
  showDir: false,
  autoIndex: false,
  root: './'
}).listen(8000, hostname);

const stringifyResult = (result) => JSON.stringify(result, Object.keys(result).filter(k => k !== 'logs'), 2);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry (attempt, numAttempts = 5, interval = 2000) {
  try {
    return await attempt();
  } catch (e) {
    if (--numAttempts === 0) {
      // reject with the last error
      throw e;
    }
    await wait(interval);
    return retry(attempt, numAttempts, interval);
  }
}

async function testLoadedData (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.onloadeddata = function () {
        callback({ code: 'loadeddata', logs: window.logString });
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('code').which.equals('loadeddata');
}

async function testIdleBufferLength (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      const autoplay = false;
      window.startStream(url, config, callback, autoplay);
      const video = window.video;
      const maxBufferLength = window.hls.config.maxBufferLength;
      video.onprogress = function () {
        const buffered = video.buffered;
        if (buffered.length) {
          const bufferEnd = buffered.end(buffered.length - 1);
          const duration = video.duration;
          console.log('[test] > progress: ' + bufferEnd.toFixed(2) + '/' + duration.toFixed(2) +
            ' buffered.length: ' + buffered.length);
          if (bufferEnd >= maxBufferLength || bufferEnd > duration - (config.avBufferOffset || 1)) {
            callback({ code: 'loadeddata', logs: window.logString });
          }
        }
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('code').which.equals('loadeddata');
}

async function testSmoothSwitch (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      window.hls.once(window.Hls.Events.FRAG_CHANGED, function (eventName, data) {
        console.log('[test] > ' + eventName + ' frag.level: ' + data.frag.level);
        window.switchToHighestLevel('next');
      });
      window.hls.on(window.Hls.Events.LEVEL_SWITCHED, function (eventName, data) {
        console.log('[test] > ' + eventName + ' data.level: ' + data.level);
        let currentTime = video.currentTime;
        const highestLevel = (window.hls.levels.length - 1);
        if (data.level === highestLevel) {
          window.setTimeout(function () {
            let newCurrentTime = video.currentTime;
            const paused = video.paused;
            console.log('[test] > currentTime delta: ' + (newCurrentTime - currentTime));
            callback({
              highestLevel: highestLevel,
              currentTimeDelta: newCurrentTime - currentTime,
              paused,
              logs: window.logString
            });
          }, 2000);
        }
      });
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('currentTimeDelta').which.is.gt(0);
}

async function testSeekOnLive (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.onloadeddata = function () {
        window.setTimeout(function () {
          video.currentTime = video.duration - 5;
        }, 5000);
      };
      video.onseeked = function () {
        callback({ code: 'seeked', logs: window.logString });
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('code').which.equals('seeked');
}

async function testSeekOnVOD (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.onloadeddata = function () {
        window.setTimeout(function () {
          const duration = video.duration;
          // After seeking timeout if paused after 5 seconds
          video.onseeked = function () {
            window.setTimeout(function () {
              const { currentTime, paused } = video;
              if (video.currentTime === 0 || video.paused) {
                callback({ code: 'paused', currentTime, paused, duration, logs: window.logString });
              }
            }, 5000);
          };
          video.currentTime = duration - 5;
          // Fail test early if more than 2 buffered ranges are found (with configured exceptions)
          const allowedBufferedRanges = config.allowedBufferedRangesInSeekTest || 2;
          video.onprogress = function () {
            if (video.buffered.length > allowedBufferedRanges) {
              callback({ code: 'buffer-gaps', bufferedRanges: video.buffered.length, duration, logs: window.logString });
            }
          };
        }, 5000);
      };
      video.onended = function () {
        callback({ code: 'ended', logs: window.logString });
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('code').which.equals('ended');
}

async function testSeekEndVOD (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.onloadeddata = function () {
        window.setTimeout(function () {
          video.currentTime = video.duration;
        }, 5000);
      };
      video.onended = function () {
        callback({ code: 'ended', logs: window.logString });
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('code').which.equals('ended');
}

async function testIsPlayingVOD (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.onloadeddata = function () {
        let expectedPlaying = !(
          video.paused || // not playing when video is paused
          video.ended || // not playing when video is ended
          video.buffered.length === 0
        ); // not playing if nothing buffered
        let currentTime = video.currentTime;
        if (expectedPlaying) {
          window.setTimeout(function () {
            console.log('[test] > video expected playing. last currentTime/new currentTime=' +
              currentTime + '/' + video.currentTime);
            callback({ playing: currentTime !== video.currentTime });
          }, 5000);
        } else {
          console.log('[test] > video not playing. paused/ended/buffered.length=' +
            video.paused + '/' + video.ended + '/' + video.buffered.length);
          callback({ playing: false });
        }
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('playing').which.is.true;
}

async function testSeekBackToStart (url, config) {
  const result = await browser.executeAsyncScript(function (url, config) {
      const callback = arguments[arguments.length - 1];
      window.startStream(url, config, callback);
      const video = window.video;
      video.ontimeupdate = function () {
        if (video.currentTime > 0 && !video.paused) {
          window.setTimeout(function () {
            video.onseeked = function () {
              delete video.onseeked;
              video.ontimeupdate = function () {
                if (video.currentTime > 0 && !video.paused) {
                  delete video.ontimeupdate;
                  callback({ playing: true });
                }
              };
            };
            video.currentTime = 0;
            delete video.ontime;
          }, 500);
        }
      };
    },
    url,
    config
  );
  expect(result, stringifyResult(result)).to.have.property('playing').which.is.true;
}

let sauceConnectProcess;
async function sauceConnect (tunnelIdentifier) {
  return new Promise(function (resolve, reject) {
    console.log(`Running sauce-connect-launcher. Tunnel id: ${tunnelIdentifier}`);
    sauceConnectLauncher({
      tunnelIdentifier
    }, function (err, sauceConnectProcess) {
      if (err) {
        console.error(err.message);
        reject(err);
        return;
      }
      console.log('Sauce Connect ready');
      resolve(sauceConnectProcess);
    });
  });
}

async function sauceDisconnect () {
  return new Promise(function (resolve) {
    if (!sauceConnectProcess) {
      resolve();
    }
    sauceConnectProcess.close(function () {
      console.log('Closed Sauce Connect process');
      resolve();
    });
  });
}

describe(`testing hls.js playback in the browser on "${browserDescription}"`, function () {
  before(async function () {
    // high timeout because sometimes getSession() takes a while
    this.timeout(100000);
    if (!stream) {
      throw new Error('Stream not defined');
    }

    const labelBranch = process.env.TRAVIS_BRANCH || 'unknown';
    let capabilities = {
      name: `hls.js@${labelBranch} on "${browserDescription}"`,
      browserName: browserConfig.name,
      platform: browserConfig.platform,
      version: browserConfig.version,
      commandTimeout: 90
    };

    if (browserConfig.name === 'chrome') {
      capabilities.chromeOptions = {
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-web-security'
        ]
      };
    }

    browser = new webdriver.Builder();
    if (onTravis) {
      capabilities['tunnel-identifier'] = process.env.TRAVIS_JOB_NUMBER;
      capabilities.build = 'HLSJS-' + process.env.TRAVIS_BUILD_NUMBER;
    } else if (useSauce) {
      capabilities['tunnel-identifier'] = `local-${Date.now()}`;
    }
    if (useSauce) {
      sauceConnectProcess = await sauceConnect(capabilities['tunnel-identifier']);
      capabilities.username = process.env.SAUCE_USERNAME;
      capabilities.accessKey = process.env.SAUCE_ACCESS_KEY;
      capabilities.avoidProxy = true;
      capabilities['record-screenshots'] = 'false';
      browser = browser.usingServer(`https://${process.env.SAUCE_USERNAME}:${process.env.SAUCE_ACCESS_KEY}@ondemand.us-west-1.saucelabs.com:443/wd/hub`);
    }

    browser = browser.withCapabilities(capabilities).build();

    let start = Date.now();

    try {
      await retry(async function () {
        console.log('Retrieving web driver session...');
        const [timeouts, session] = await Promise.all([
          browser.manage().setTimeouts({ script: 75000 }),
          browser.getSession()
        ]);
        console.log(`Retrieved session in ${Date.now() - start}ms`);
        if (useSauce) {
          console.log(`Job URL: https://saucelabs.com/jobs/${session.getId()}`);
        } else {
          console.log(`WebDriver SessionID: ${session.getId()}`);
        }
      });
    } catch (err) {
      await sauceDisconnect();
      throw new Error(`failed setting up session: ${err}`);
    }
  });

  beforeEach(async function () {
    try {
      await retry(async () => {
        if (printDebugLogs) {
          console.log('Loading test page...');
        }
        try {
          await browser.get(`http://${hostname}:8000/tests/functional/auto/index.html`);
        } catch (e) {
          throw new Error('failed to open test page');
        }
        if (printDebugLogs) {
          console.log('Test page loaded.');
        }
        try {
          await browser.wait(
            until.elementLocated(By.css('body#hlsjs-functional-tests')),
            5000,
            'Failed to load test page, source of other page below.'
          );
        } catch (e) {
          const source = await browser.getPageSource();
          console.log(source);
          throw e;
        }
        if (printDebugLogs) {
          console.log('Test harness found, page confirmed loaded');
        }
      });
    } catch (e) {
      throw new Error(`error getting test page loaded: ${e}`);
    }
  });

  afterEach(async function () {
    const failed = this.currentTest.isFailed();
    if (printDebugLogs || failed) {
      const logString = await browser.executeScript('return logString');
      console.log(`${onTravis ? 'travis_fold:start:debug_logs' : ''}\n${logString}\n${onTravis ? 'travis_fold:end:debug_logs' : ''}`);
      if (failed && useSauce) {
        browser.executeScript('sauce:job-result=failed');
      }
    }
  });

  after(async function () {
    if (useSauce && this.currentTest && this.currentTest.parent) {
      const tests = this.currentTest.parent.tests;
      if (tests && tests.length && tests.every(test => test.isPassed())) {
        browser.executeScript('sauce:job-result=passed');
      }
    }
    console.log('Quitting browser...');
    await browser.quit();
    console.log('Browser quit.');
    if (useSauce) {
      await sauceDisconnect();
    }
  });

  for (let name in streams) {
    stream = streams[name];
    let url = stream.url;
    let config = stream.config || {};
    if (
      !stream.blacklist_ua ||
      stream.blacklist_ua.indexOf(browserConfig.name) === -1
    ) {
      it(
        `should receive video loadeddata event for ${stream.description}`,
        testLoadedData.bind(null, url, config)
      );

      if (stream.startSeek) {
        it(
          `seek back to start and play for ${stream.description}`,
          testSeekBackToStart.bind(null, url, config)
        );
      }

      if (stream.abr) {
        it(
          `should "smooth switch" to highest level and still play(readyState === 4) after 12s for ${stream.description}`,
          testSmoothSwitch.bind(null, url, config)
        );
      }

      if (stream.live) {
        it(
          `should seek near the end and receive video seeked event for ${stream.description}`,
          testSeekOnLive.bind(null, url, config)
        );
      } else {
        it(
          `should buffer up to maxBufferLength or video.duration for ${stream.description}`,
          testIdleBufferLength.bind(null, url, config)
        );
        it(
          `should play ${stream.description}`,
          testIsPlayingVOD.bind(null, url, config)
        );
        it(
          `should seek 5s from end and receive video ended event for ${stream.description} with 2 or less buffered ranges`,
          testSeekOnVOD.bind(null, url, config)
        );
        // it(`should seek on end and receive video ended event for ${stream.description}`, testSeekEndVOD.bind(null, url));
      }
    }
  }
});
