import * as github from '@actions/github'
import * as githubCore from '@actions/core'
import S3 from '../s3Client'
import s3UploadDirectory from '../utils/s3UploadDirectory'
import validateEnvVars from '../utils/validateEnvVars'
import checkBucketExists from '../utils/checkBucketExists'
import githubClient from '../githubClient'
import deactivateDeployments from '../utils/deactivateDeployments'
import { ReposCreateDeploymentResponseData } from '@octokit/types'

export const requiredEnvVars = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN']

export default async (bucketName: string, uploadDirectory: string, environmentPrefix: string) => {
	const websiteUrl = `https://s3.amazonaws.com/${bucketName}/index.html`
	const { repo } = github.context
	const branchName = github.context.payload.pull_request!.head.ref

	console.log('PR Updated')

	validateEnvVars(requiredEnvVars)

	const bucketExists = await checkBucketExists(bucketName)

	if (!bucketExists) {
		console.log(`S3 bucket does not exist. Creating ${bucketName}...`)
		await S3.createBucket({ Bucket: bucketName }).promise()

		await S3.putBucketOwnershipControls({
			Bucket: bucketName,
			OwnershipControls: {
				Rules: [
					{
						ObjectOwnership: 'ObjectWriter'
					}
				]
			}
		}).promise()

		console.log('Configuring bucket website...')
		await S3.putBucketWebsite({
			Bucket: bucketName,
			WebsiteConfiguration: {
				IndexDocument: { Suffix: 'index.html' },
				ErrorDocument: { Key: 'index.html' }
			}
		}).promise()
	} else {
		console.log('S3 Bucket already exists. Skipping creation...')
	}

	await deactivateDeployments(repo, environmentPrefix)

	const deployment = await githubClient.repos.createDeployment({
		...repo,
		ref: `refs/heads/${branchName}`,
		environment: `${environmentPrefix || 'PR-'}${github.context.payload.pull_request!.number}`,
		auto_merge: false,
		transient_environment: true,
		required_contexts: []
	})

	if (isSuccessResponse(deployment.data)) {
		await githubClient.repos.createDeploymentStatus({
			...repo,
			deployment_id: deployment.data.id,
			state: 'in_progress'
		})

		console.log('Uploading files...')
		await s3UploadDirectory(bucketName, uploadDirectory)

		await githubClient.repos.createDeploymentStatus({
			...repo,
			deployment_id: deployment.data.id,
			state: 'success',
			environment_url: websiteUrl
		})

		githubCore.setOutput('websiteUrl', websiteUrl)

		console.log(`Website URL: ${websiteUrl}`)
	}
}

function isSuccessResponse(object: any): object is ReposCreateDeploymentResponseData {
	return 'id' in object
}
