// const AWS = require("aws-sdk");
const AmazonS3URI = require("amazon-s3-uri");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");

function formatContent() {
  var sentiments = document.getElementsByClassName("sentiment");
  for (var i = 0; i < sentiments.length; i++) {
    if (sentiments[i].innerHTML == "[POSITIVE]") {
      sentiments[i].style.color = "lime"
    }
    else if (sentiments[i].innerHTML == "[NEGATIVE]") {
      sentiments[i].style.color = "red"
    }
  }
}

module.exports = function parseJSONWrapper(url) {
  const { bucket, key } = AmazonS3URI(url);
  const params = {
    Bucket: bucket,
    Key: key,
  };
  const s3Client = new S3Client();
  const run = async () => {
    let str = "";
    try {
      // Create a helper function to convert a ReadableStream to a string.
      const streamToString = (stream) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () =>
            resolve(Buffer.concat(chunks).toString("utf8"))
          );
        });

      // Get the object} from the Amazon S3 bucket. It is returned as a ReadableStream.
      const data = await s3Client.send(new GetObjectCommand(params));
      //   return data; // For unit tests.
      // Convert the ReadableStream to a string.
      const bodyContents = await streamToString(data.Body);
      console.log(JSON.parse(bodyContents));
      JSON.parse(bodyContents).Transcript.forEach(element => str = str.concat(element["Content"]).concat(`<span class="sentiment">[${element["Sentiment"]}]</span><br>`))
      str = str.concat(`\n<div style="text-align: right;"><b>Overall Sentiment: ${JSON.parse(bodyContents).ConversationCharacteristics["Sentiment"]["OverallSentiment"]["AGENT"]}</b></div>`)
    } catch (err) {
      console.log("Error", err);
      str.concat(err);
    } finally {
      var ele = document.createElement("p");
      var ele1 = document.createElement("p");
      ele1.innerHTML = "<br><h3 class='py-3'>Transcript w/ Sentiment Analysis: -</h3>";
      ele.setAttribute("id", "content");
      ele1.setAttribute("id", "content1");
      ele.setAttribute("style", "text-align: justify!important");
      ele.innerHTML = str;
      document.getElementById("status").innerHTML = "";
      document.getElementById("status").appendChild(ele1);
      document.getElementById("status").appendChild(ele);
      formatContent();
    }
  };
  run();
};
