const {
    TranscribeClient,
    StartCallAnalyticsJobCommand,
    GetCallAnalyticsJobCommand,
  } = require("@aws-sdk/client-transcribe");
  
  var parseJSON = require("./getTranscript");
  
  module.exports = function transcribeWrapper(S3URI) {
    const client = new TranscribeClient();
    const today = new Date();
    const filePath = S3URI.split("/");
    const JobName = Date.now().toString();
    const params = {
      CallAnalyticsJobName: JobName,
      ChannelDefinitions: [
        {
          ChannelId: 0,
          ParticipantRole: "AGENT",
        },
        {
          ChannelId: 1,
          ParticipantRole: "CUSTOMER",
        },
      ],
      MediaFormat: S3URI.split(".")[1],
      Media: {
        MediaFileUri: S3URI,
      },
      OutputLocation:
        S3URI.split("/").slice(0, 3).join("/").toString() + "/transcripts/",
    };
    // var transcript = parseJSON("https://s3.us-west-2.amazonaws.com/internstackbucket/transcripts/analytics/1655199250483.json");
    const getData = async (job) => {
      let dataFetched = await client.send(new GetCallAnalyticsJobCommand(job));
      console.log(dataFetched);
      if (
        dataFetched.CallAnalyticsJob["CallAnalyticsJobStatus"] != "IN_PROGRESS" &&
        dataFetched.CallAnalyticsJob["CallAnalyticsJobStatus"] != "QUEUED"
      ) {
        console.log("Finished!");
        clearTimeout(int);
        $("#uploadToS3").removeAttr("disabled");
        document.getElementById("status").innerHTML = dataFetched.CallAnalyticsJob.Transcript.TranscriptFileUri;
        var transcript = parseJSON(dataFetched.CallAnalyticsJob.Transcript.TranscriptFileUri);
        // document.getElementById("status").innerHTML = transcript;
  
      } else {
        var int = setTimeout(() => {
          if (
            dataFetched.CallAnalyticsJob["CallAnalyticsJobStatus"] !=
              "IN_PROGRESS" &&
            dataFetched.CallAnalyticsJob["CallAnalyticsJobStatus"] != "QUEUED"
          ) {
            // console.log("Finished!");
            clearTimeout(int);
            // document.getElementById("status").innerHTML = dataFetched;
          } else {
            getData({ CallAnalyticsJobName: JobName });
          }
        }, 90000);
      }
    };
    const run = async () => {
      try {
        const data = await client.send(new StartCallAnalyticsJobCommand(params));
        console.log("Success - put", data);
        document.getElementById("status").innerHTML = "Successfully Initiated Call Analysis Transcription Job, Awaiting Results!";
        getData({ CallAnalyticsJobName: JobName });
        console.log("OK");
      } catch (err) {
        console.log("Error", err);
        document.getElementById("status").innerHTML = err;
      }
    };
    run();
  };
  