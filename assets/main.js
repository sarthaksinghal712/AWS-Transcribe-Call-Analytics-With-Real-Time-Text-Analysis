const path = require("path");
const audioUtils = require(path.join(__dirname,"\\assets\\audioUtils.js")); // for encoding audio data as PCM
const crypto = require("crypto"); // tot sign our pre-signed URL
const v4 = require(path.join(__dirname,"\\assets\\aws-signature-v4")); // to generate our pre-signed URL
const marshaller = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic = require("microphone-stream"); // collect microphone input as a stream of raw bytes
const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
global.jQuery = global.$ = require("jquery");
const AWS = require("aws-sdk");
const fs = require("fs");
var gotranscribe = require(path.join(__dirname,"\\assets\\transcribeIt"));
const AmazonS3URI = require("amazon-s3-uri");
const envir = require("dotenv");
envir.config();


// our converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(
  util_utf8_node.toUtf8,
  util_utf8_node.fromUtf8
);

// our global variables for managing state
let languageCode;
let region;
let sampleRate;
let inputSampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;

// check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
  // Use our helper method to show an error on the page
  showError(
    "We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again."
  );

  // maintain enabled/distabled state for the start and stop buttons
  toggleStartStop();
}

$("#start-button").click(function () {
  document.getElementById("transcript").disabled = true;
  $("#error").hide(); // hide any existing errors
  toggleStartStop(true); // disable start and enable stop button

  // set the language and region from the dropdowns
  setLanguage();
  setRegion();

  // first we get the microphone input from the browser (as a promise)...
  window.navigator.mediaDevices
    .getUserMedia({
      video: false,
      audio: true,
    })
    // ...then we convert the mic stream to binary event stream messages when the promise resolves
    .then(streamAudioToWebSocket)
    .catch(function (error) {
      showError(
        "There was an error streaming your audio to Amazon Transcribe. Please try again."
      );
      toggleStartStop();
    });
});

let streamAudioToWebSocket = function (userMediaStream) {
  //let's get the mic input from the browser, via the microphone-stream module
  micStream = new mic();

  micStream.on("format", function (data) {
    inputSampleRate = data.sampleRate;
  });

  micStream.setStream(userMediaStream);

  // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
  // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  let url = createPresignedUrl();

  //open up our WebSocket connection
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  let sampleRate = 0;

  // when we get audio data from the mic, send it to the WebSocket if possible
  socket.onopen = function () {
    micStream.on("data", function (rawAudioChunk) {
      // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
      let binary = convertAudioToBinaryMessage(rawAudioChunk);

      if (socket.readyState === socket.OPEN) socket.send(binary);
    });
  };

  // handle messages, errors, and close events
  wireSocketEvents();
};

function setLanguage() {
  languageCode = "en-US";
  sampleRate = 44100;
}

function setRegion() {
  region = "us-west-2";
}

function wireSocketEvents() {
  // handle inbound messages from Amazon Transcribe
  socket.onmessage = function (message) {
    //convert the binary event stream message to JSON
    let messageWrapper = eventStreamMarshaller.unmarshall(
      Buffer.from(message.data)
    );
    let messageBody = JSON.parse(
      String.fromCharCode.apply(String, messageWrapper.body)
    );
    if (messageWrapper.headers[":message-type"].value === "event") {
      handleEventStreamMessage(messageBody);
    } else {
      transcribeException = true;
      showError(messageBody.Message);
      toggleStartStop();
    }
  };

  socket.onerror = function () {
    socketError = true;
    showError("WebSocket connection error. Try again.");
    toggleStartStop();
  };

  socket.onclose = function (closeEvent) {
    micStream.stop();

    // the close event immediately follows the error event; only handle one.
    if (!socketError && !transcribeException) {
      if (closeEvent.code != 1000) {
        showError(
          "</i><strong>Streaming Exception</strong><br>" + closeEvent.reason
        );
      }
      toggleStartStop();
    }
  };
}

let handleEventStreamMessage = function (messageJson) {
  let results = messageJson.Transcript.Results;

  if (results.length > 0) {
    if (results[0].Alternatives.length > 0) {
      let transcript = results[0].Alternatives[0].Transcript;

      // fix encoding for accented characters
      transcript = decodeURIComponent(escape(transcript));

      // update the textarea with the latest result
      $("#transcript").val(transcription + transcript + "\n");

      // if this transcript segment is final, add it to the overall transcription
      if (!results[0].IsPartial) {
        //scroll the textarea down
        $("#transcript").scrollTop($("#transcript")[0].scrollHeight);

        transcription += transcript + "\n";
      }
    }
  }
};

let closeSocket = function () {
  if (socket.readyState === socket.OPEN) {
    micStream.stop();

    // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
    let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer.from([])));
    let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
    socket.send(emptyBuffer);
  }
};

$("#stop-button").click(function () {
  closeSocket();
  toggleStartStop();
  document.getElementById("transcript").disabled = false;
  checkValue();
});

$("#reset-button").click(function () {
  $("#transcript").val("");
  transcription = "";
});

function toggleStartStop(disableStart = false) {
  $("#start-button").prop("disabled", disableStart);
  $("#stop-button").attr("disabled", !disableStart);
}

function showError(message) {
  $("#error").html('<i class="fa fa-times-circle"></i> ' + message);
  $("#error").show();
}

function convertAudioToBinaryMessage(audioChunk) {
  let raw = mic.toRaw(audioChunk);

  if (raw == null) return;

  // downsample and convert the raw audio bytes to PCM
  let downsampledBuffer = audioUtils.downsampleBuffer(
    raw,
    inputSampleRate,
    sampleRate
  );
  let pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

  // add the right JSON headers and structure to the message
  let audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

  //convert the JSON object + headers into a binary event stream message
  let binary = eventStreamMarshaller.marshall(audioEventMessage);

  return binary;
}

function getAudioEventMessage(buffer) {
  // wrap the audio data in a JSON envelope
  return {
    headers: {
      ":message-type": {
        type: "string",
        value: "event",
      },
      ":event-type": {
        type: "string",
        value: "AudioEvent",
      },
    },
    body: buffer,
  };
}

function createPresignedUrl() {
  let endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

  // get a preauthenticated URL that we can use to establish our WebSocket
  return v4.createPresignedURL(
    "GET",
    endpoint,
    "/stream-transcription-websocket",
    "transcribe",
    crypto.createHash("sha256").update("", "utf8").digest("hex"),
    {
      key: AWS_ACCESS_KEY,
      secret: AWS_SECRET_KEY,
      protocol: "wss",
      expires: 15,
      region: region,
      query:
        "language-code=" +
        languageCode +
        "&media-encoding=pcm&sample-rate=" +
        sampleRate,
    }
  );
}

function changeHeight(param) {
  setTimeout(function () {
    $("#cont").attr(
      "style",
      "position: fixed; top:0; z-index:10; justify-content:center; align-items:center; padding-top:5vh; padding-bottom:5vh;"
    );
  }, 1000);
  $("#cont").animate(
    {
      height: "15vh",
    },
    1000
  );

  if (param === "batch") {
    $("#realCont").fadeOut();
    setTimeout(function () {
      $("#batchCont").fadeIn();
      // document.getElementById("status").innerHTML = "";
      // $("#fileUploadButton").val("");
    }, 1200);
  }

  if (param === "real") {
    $("#batchCont").fadeOut();
    setTimeout(function () {
      $("#realCont").fadeIn();
      // document.getElementById("status").innerHTML = "";
    }, 1200);
    checkValue();
  }
}

function checkValue() {
  console.log("cv");
  if ($("#transcript").val()) {
    console.log("Not Empty");
    $("#comprehend-button").attr("disabled", false);
  } else {
    console.log("Empty");
    $("#comprehend-button").attr("disabled", true);
  }
}

$("#comprehend-button").on("click", function () {
  const AWS = require("aws-sdk");
  AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY,
    secretAccessKey: process.env.AWS_SECRET_KEY,
    region: process.env.AWS_REGION,
  });
  const client = new AWS.Comprehend();
  const params = {
    LanguageCode: "en",
    Text: document.getElementById("transcript").value,
  };
  // const command = new DetectSentimentCommand(params);
  // const response = await client.send(command);
  // console.log(response);
  client.detectSentiment(params, function (err, data) {
    if (err) console.log(err, err.stack); // an error occurred
    else {
      const q =
        data.Sentiment.toLowerCase().charAt(0).toUpperCase() +
        data.Sentiment.slice(1).toLowerCase();
      $("#result").text(
        data.Sentiment.toString().concat(
          " | Score: "
            .concat(parseFloat(data.SentimentScore[q] * 100).toFixed(2))
            .concat("%")
        )
      );
      console.log(data.Sentiment.toString().concat(data.SentimentScore[q]));
    } // successful response
  });
});

function upload() {
  $("#uploadToS3").attr("disabled", "true");
  const file = document.getElementById("fileUploadButton").files[0];
  try {
    fs.readFile(file.path, (err, data) => {
      if (err) {
        document.getElementById("status").innerHTML = err;
        return;
      }
      document.getElementById("status").innerHTML = "File Upload Initiated!";
      const params = {
        Bucket: "internstackbucket",
        Key: "audio/" + file.name,
        Body: data,
        ACL: "public-read",
        ContentType: file.type,
      };
      const S3 = new AWS.S3();
      S3.upload(params, function (s3Err, data) {
        if (s3Err) {
          document.getElementById("status").innerText = s3Err;
          return;
        }
        console.log(`File uploaded successfully at ${data.Location}`);
        document.getElementById("status").innerHTML =
          "File uploaded successfully";
        const S3URI = fetchS3URI(data.Location);
        document.getElementById("status").innerHTML = S3URI;
        console.log(S3URI);
        gotranscribe(S3URI);
        // gotranscribe("s3://internstackbucket/audio/InboundSampleRecording.mp3")
      });
    });
  } catch (err) {
    document.getElementById("status").innerHTML = err;
    $("#uploadToS3").removeAttr("disabled");
  }
}

function fetchS3URI(url) {
  //   fetch(key);
  const { bucket, key } = AmazonS3URI(url);
  const S3URI = "s3://" + bucket + "/" + key;
  return S3URI;
}
